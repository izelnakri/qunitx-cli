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
