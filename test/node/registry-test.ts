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
    const zedUnit = Node.serve(zed, 'room:lobby', behavior('zed'), {
      via: { registry: 'rooms', key: 'lobby' },
    });
    const abeUnit = Node.serve(abe, 'room:lobby', behavior('abe'), {
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
    const unit = Node.serve(
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
