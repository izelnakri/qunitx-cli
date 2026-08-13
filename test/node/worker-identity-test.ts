import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await settle(10);
  return cond();
};

// A respawned worker REUSES its dead predecessor's node name (stable per-slot identity — an Erlang
// named process keeps its name through a restart; a fresh name per generation would leak a CRDT
// version-vector entry forever under crash-churn). But a reused name is a CRDT footgun: the peer
// still holds the dead incarnation's version vector, so a fresh replica's dots (minted from vv=0)
// land UNDER that high-water and are dropped as already-seen. `node.synced()` closes the gap —
// merge the cluster's context (learning the reused name's high-water) BEFORE minting any dot.
module('Node | reused-name identity (synced gate)', () => {
  test('synced() resolves after merging a peer full-state, or the grace window with no peers', async (assert) => {
    const hub = Node.memoryHub();
    const obs = Node.start('obs@id', hub.transport());
    obs.register('slot', 'k'); // some state for the joiner to pull
    await settle();
    const joiner = Node.start('joiner@id', hub.transport());
    await joiner.synced(); // resolves on obs's hello full-state reply
    assert.strictEqual(joiner.whereis('slot', 'k'), 'obs@id', 'synced() implies the state merged');
    obs.stop();
    joiner.stop();

    // A lone node with no peers still resolves synced() (via the grace window) — it never blocks.
    const lone = Node.start('lone@id', Node.memoryHub().transport());
    await lone.synced();
    assert.true(true, 'a peerless node resolved synced() without hanging');
    lone.stop();
  });

  test('a reused name that waits for sync converges — its fresh dots clear the dead high-water', async (assert) => {
    const hub = Node.memoryHub();
    const obs = Node.start('obs@id', hub.transport());
    // First incarnation of 'w@id' registers several keys, then dies — obs retains vv[w@id] = 3.
    const w1 = Node.start('w@id', hub.transport());
    await settle();
    w1.register('slot', 'k1');
    w1.register('slot', 'k2');
    w1.register('slot', 'k3');
    await settle();
    assert.strictEqual(obs.whereis('slot', 'k1'), 'w@id', 'the first incarnation registered');
    w1.stop(); // dies; obs prunes its facts but keeps the causal context vv[w@id] = 3
    await settle();

    // A NEW incarnation REUSES the name and waits for sync before registering.
    const w2 = Node.start('w@id', hub.transport());
    await w2.synced(); // merges obs's context: w2 now knows vv[w@id] = 3, so it mints w@id:4
    w2.register('slot', 'fresh');
    assert.true(
      await until(() => obs.whereis('slot', 'fresh') === 'w@id'),
      'the reused-name registration converged — no dot collision with the dead incarnation',
    );
    obs.stop();
    w2.stop();
  });

  test('WITHOUT the sync wait the reused dot collides and the registration is lost', async (assert) => {
    // The characterization that justifies the gate: registering on a reused name BEFORE merging the
    // peer's context mints a dot the peer already counts as seen → it is silently dropped, forever.
    const hub = Node.memoryHub();
    const obs = Node.start('obs@id', hub.transport());
    const w1 = Node.start('w@id', hub.transport());
    await settle();
    w1.register('slot', 'k1'); // obs learns vv[w@id] = 1
    await settle();
    w1.stop();
    await settle();

    const w2 = Node.start('w@id', hub.transport());
    w2.register('slot', 'fresh'); // IMMEDIATELY, before sync — mints w@id:1, which obs already saw
    await settle(60);
    assert.strictEqual(
      obs.whereis('slot', 'fresh'),
      null,
      'the collided dot was dropped as already-seen — the gate is what prevents this',
    );
    obs.stop();
    w2.stop();
  });
});
