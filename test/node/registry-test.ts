import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { Failure } from '../../lib/task/index.ts';

const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

module('Node | registry', () => {
  test('register + whereis across nodes; a via: call routes to the ONE owner', async (assert) => {
    const hub = Node.memoryHub();
    const host = Node.start('host@memory', hub.transport());
    const cli = Node.start('cli@memory', hub.transport());
    host.register('rooms', 'lobby');
    host.handle('room:lobby.say', (msg) => `lobby heard: ${msg}`);
    await settle();
    assert.strictEqual(
      cli.whereis('rooms', 'lobby'),
      'host@memory',
      'the owner is known cluster-wide',
    );
    assert.strictEqual(
      await cli.call('via:rooms/lobby', 'room:lobby.say', 'hi'),
      'lobby heard: hi',
    );
    host.stop();
    cli.stop();
  });

  test('an unowned key rejects with a declared NotRegistered', async (assert) => {
    const hub = Node.memoryHub();
    const cli = Node.start('cli@memory', hub.transport());
    const outcome = await cli.call('via:rooms/ghost', 'anything').result();
    assert.true(Failure.is(outcome));
    assert.strictEqual((outcome as Failure.Any).code, 'NotRegistered');
    cli.stop();
  });

  test('a conflict converges: smallest node name wins, everywhere', async (assert) => {
    const hub = Node.memoryHub();
    const zed = Node.start('zed@memory', hub.transport());
    const abe = Node.start('abe@memory', hub.transport());
    const watch = Node.start('watch@memory', hub.transport());
    await settle();
    zed.register('rooms', 'lobby'); // both claim the SAME key…
    abe.register('rooms', 'lobby');
    await settle();
    // …and every node converges on 'abe@memory' (lexicographically smaller) — deterministic.
    assert.strictEqual(zed.whereis('rooms', 'lobby'), 'abe@memory');
    assert.strictEqual(abe.whereis('rooms', 'lobby'), 'abe@memory');
    assert.strictEqual(watch.whereis('rooms', 'lobby'), 'abe@memory');
    zed.stop();
    abe.stop();
    watch.stop();
  });

  test('a late joiner learns existing registrations from the hello replay', async (assert) => {
    const hub = Node.memoryHub();
    const host = Node.start('host@memory', hub.transport());
    host.register('rooms', 'lobby');
    await settle();
    const late = Node.start('late@memory', hub.transport()); // joins AFTER the registration
    await settle();
    assert.strictEqual(late.whereis('rooms', 'lobby'), 'host@memory', 'replayed on hello');
    assert.deepEqual(late.registered('rooms'), ['lobby']);
    host.stop();
    late.stop();
  });

  test('unregister and node death both release the key', async (assert) => {
    const hub = Node.memoryHub();
    const host = Node.start('host@memory', hub.transport());
    const cli = Node.start('cli@memory', hub.transport());
    host.register('rooms', 'a');
    host.register('rooms', 'b');
    await settle();
    host.unregister('rooms', 'a');
    await settle();
    assert.strictEqual(cli.whereis('rooms', 'a'), null, 'explicit unregister');
    assert.strictEqual(cli.whereis('rooms', 'b'), 'host@memory');
    host.stop(); // bye prunes everything it owned
    await settle();
    assert.strictEqual(cli.whereis('rooms', 'b'), null, 'nodedown released the rest');
    cli.stop();
  });
});

// ── {:via, Registry} — split-brain closure ───────────────────────────────────

module('Node | via registration', () => {
  const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

  test('two nodes serve the SAME via key → exactly one survives; the loser is torn down', async (assert) => {
    const hub = Node.memoryHub();
    const zed = Node.start('zed@memory', hub.transport());
    const abe = Node.start('abe@memory', hub.transport());
    const cli = Node.start('cli@memory', hub.transport());
    await settle();

    // Both start a unit under the SAME registry key — a split-brain race.
    const behavior = (who: string): Node.Behavior<number> => ({
      version: '1',
      init: () => 0,
      handlers: { who: (s) => ({ state: s, reply: who }) },
    });
    const zedUnit = Node.genServer(zed, 'room:lobby', behavior('zed'), {
      via: { registry: 'rooms', key: 'lobby' },
    });
    const abeUnit = Node.genServer(abe, 'room:lobby', behavior('abe'), {
      via: { registry: 'rooms', key: 'lobby' },
    });
    await settle();

    // The smaller name (abe) wins; zed's unit self-terminated.
    assert.true(zedUnit.isAlive() !== abeUnit.isAlive(), 'exactly one is alive');
    assert.true(abeUnit.isAlive(), 'the smaller-named node kept the key');
    assert.false(zedUnit.isAlive(), 'the loser tore itself down (UnitDown/Conflict)');
    assert.strictEqual(
      cli.whereis('rooms', 'lobby'),
      'abe@memory',
      'everyone converges on the survivor',
    );
    assert.strictEqual(
      await cli.call('via:rooms/lobby', 'room:lobby.who'),
      'abe',
      'routes to the survivor',
    );
    zed.stop();
    abe.stop();
    cli.stop();
  });

  test('exit() on a via unit releases the key', async (assert) => {
    const hub = Node.memoryHub();
    const host = Node.start('host@memory', hub.transport());
    const cli = Node.start('cli@memory', hub.transport());
    const unit = Node.genServer(
      host,
      'room:x',
      { version: '1', init: () => 0, handlers: {} },
      { via: { registry: 'rooms', key: 'x' } },
    );
    await settle();
    assert.strictEqual(cli.whereis('rooms', 'x'), 'host@memory');
    unit.exit();
    await settle();
    assert.strictEqual(cli.whereis('rooms', 'x'), null, 'exit unregistered the key');
    host.stop();
    cli.stop();
  });
});

// ── anti-entropy — the CRDT convergence backstop under frame loss ─────────────

module('Node | anti-entropy', () => {
  const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  test('a registration lost to frame drop still converges via anti-entropy', async (assert) => {
    // A lossy in-process hub: DROP every one-op 'crdt' delta broadcast (simulate packet loss),
    // but let 'sync'/full-state and everything else through. Only anti-entropy can recover.
    const inner = Node.memoryHub();
    const lossy = {
      transport() {
        const t = inner.transport();
        return {
          send(f: Node.Frame) {
            // Drop one-op BROADCASTS (crdt with a single delta), but let anti-entropy through — a
            // full-state frame OR a delta BATCH (`frame.deltas`). That's the whole point: a lost
            // broadcast is healed by the periodic anti-entropy catch-up.
            if (f.kind === 'crdt' && !f.full && !f.deltas) return;
            t.send(f);
          },
          onFrame: (h: (f: Node.Frame) => void) => t.onFrame(h),
          close: t.close,
        };
      },
    };
    // Fast anti-entropy so the test converges quickly.
    const host = Node.start('host@memory', lossy.transport(), { antiEntropyMs: 25 });
    const cli = Node.start('cli@memory', lossy.transport(), { antiEntropyMs: 25 });
    await settle();
    host.register('rooms', 'lobby'); // the delta broadcast is DROPPED
    await settle(15);
    // Right away the client hasn't heard (its delta was lost)…
    // …but anti-entropy pulls it within a couple of sync rounds.
    const until = async (cond: () => boolean, ms = 2000) => {
      const deadline = Date.now() + ms;
      while (!cond() && Date.now() < deadline) await settle(10);
      return cond();
    };
    assert.true(
      await until(() => cli.whereis('rooms', 'lobby') === 'host@memory'),
      'converged despite the dropped delta',
    );
    host.stop();
    cli.stop();
  });

  test('a healed partition reconciles to ONE owner (no split-brain)', async (assert) => {
    // Two nodes register the SAME key while partitioned (no delivery), then heal.
    let partitioned = true;
    const inner = Node.memoryHub();
    const reopens: (() => void)[] = [];
    const gated = () => {
      const t = inner.transport();
      return {
        send: (f: Node.Frame) => (partitioned ? undefined : t.send(f)),
        onFrame: (h: (f: Node.Frame) => void) => t.onFrame(h),
        onReopen: (cb: () => void) => reopens.push(cb),
        close: t.close,
      };
    };
    const abe = Node.start('abe@memory', gated(), { antiEntropyMs: 25, tick: false });
    const zed = Node.start('zed@memory', gated(), { antiEntropyMs: 25, tick: false });
    abe.register('rooms', 'lobby'); // both claim, in isolation
    zed.register('rooms', 'lobby');
    await settle();
    partitioned = false; // heal — a reconnecting transport re-runs the handshake (onReopen)
    for (const reopen of reopens) reopen();
    const until = async (cond: () => boolean, ms = 2000) => {
      const deadline = Date.now() + ms;
      while (!cond() && Date.now() < deadline) await settle(10);
      return cond();
    };
    assert.true(
      await until(
        () =>
          abe.whereis('rooms', 'lobby') === 'abe@memory' &&
          zed.whereis('rooms', 'lobby') === 'abe@memory',
      ),
      'both converge on the smaller-named owner after heal',
    );
    abe.stop();
    zed.stop();
  });
});
