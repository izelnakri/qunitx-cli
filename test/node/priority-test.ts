import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';

const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

// Option A: per-call priority via an options object on call/cast. It rides the frame, reaches the
// handler (meta.priority / self.priority), and elevates the receiving unit's pump yield. Propagation
// is explicit — a handler re-passes self.priority to its nested calls.
module('Node | per-call priority (Option A)', () => {
  test('the 4th arg is still a bare timeout (backward compatible)', async (assert) => {
    const hub = Node.memoryHub();
    const srv = Node.start('srv@pri', hub.transport());
    const cli = Node.start('cli@pri', hub.transport());
    srv.handle('echo', (p) => p);
    await settle();
    assert.strictEqual(await cli.call('srv@pri', 'echo', 'hi', 1000), 'hi', 'number timeout works');
    assert.strictEqual(
      await cli.call('srv@pri', 'echo', 'yo', { timeoutMs: 1000 }),
      'yo',
      'options-object timeout works',
    );
    srv.stop();
    cli.stop();
  });

  test('priority rides the frame and reaches the handler as meta.priority', async (assert) => {
    const hub = Node.memoryHub();
    const srv = Node.start('srv@pri', hub.transport());
    const cli = Node.start('cli@pri', hub.transport());
    srv.handle('pri', (_p, _from, meta) => meta?.priority ?? 'none');
    await settle();
    assert.strictEqual(
      await cli.call('srv@pri', 'pri', null, { priority: 'high' }),
      'high',
      'the handler saw the carried priority',
    );
    assert.strictEqual(
      await cli.call('srv@pri', 'pri', null),
      'none',
      'no priority set → undefined at the handler',
    );
    srv.stop();
    cli.stop();
  });

  test('a genServer handler reads self.priority', async (assert) => {
    const hub = Node.memoryHub();
    const node = Node.start('n@pri', hub.transport());
    Node.genServer(node, 'u', {
      version: '1',
      init: () => 0,
      handlers: {
        which: (s: number, _p: unknown, self: Node.Self) => ({
          state: s,
          reply: self.priority ?? 'none',
        }),
      },
    });
    const cli = Node.start('cli@pri', hub.transport());
    await settle();
    assert.strictEqual(await cli.call('n@pri', 'u.which', null, { priority: 'low' }), 'low');
    node.stop();
    cli.stop();
  });

  test('a handler PROPAGATES priority to a nested call (explicit)', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('A@pri', hub.transport());
    const b = Node.start('B@pri', hub.transport());
    const c = Node.start('C@pri', hub.transport());
    b.handle('inner', (_p, _from, meta) => meta?.priority ?? 'none');
    // A's handler forwards the priority it received to its downstream call to B.
    a.handle('outer', (_p, _from, meta) =>
      a.call('B@pri', 'inner', null, { priority: meta?.priority }),
    );
    await settle();
    assert.strictEqual(
      await c.call('A@pri', 'outer', null, { priority: 'high' }),
      'high',
      'priority propagated across two hops because the handler re-passed it',
    );
    a.stop();
    b.stop();
    c.stop();
  });

  test('self.setPriority changes the unit base priority at runtime (Process.flag(:priority))', async (assert) => {
    const hub = Node.memoryHub();
    const node = Node.start('n@flag', hub.transport());
    Node.genServer(node, 'u', {
      version: '1',
      init: () => 0,
      handlers: {
        raise: (s: number, _p: unknown, self: Node.Self) => ({
          state: s,
          reply: self.setPriority('high'), // returns the PREVIOUS priority (Erlang process_flag)
        }),
      },
    });
    const cli = Node.start('cli@flag', hub.transport());
    await settle();
    assert.strictEqual(
      await cli.call('n@flag', 'u.raise'),
      'normal',
      'returned the previous value',
    );
    assert.strictEqual(await cli.call('n@flag', 'u.raise'), 'high', 'the change persisted');
    node.stop();
    cli.stop();
  });

  test('cast carries priority too', async (assert) => {
    const hub = Node.memoryHub();
    const srv = Node.start('srv@pri', hub.transport());
    const cli = Node.start('cli@pri', hub.transport());
    let seen: unknown = 'unset';
    srv.handle('note', (_p, _from, meta) => void (seen = meta?.priority ?? 'none'));
    await settle();
    cli.cast('srv@pri', 'note', null, { priority: 'high' });
    await settle();
    assert.strictEqual(seen, 'high', 'the cast delivered its priority to the handler');
    srv.stop();
    cli.stop();
  });

  test('the local client (unit.call / unit.cast) carries priority too', async (assert) => {
    const hub = Node.memoryHub();
    const node = Node.start('n@local', hub.transport());
    let castSeen: unknown = 'unset';
    const unit = Node.genServer(node, 'u', {
      version: '1',
      init: () => 0,
      handlers: {
        which: (s: number, _p: unknown, self: Node.Self) => ({
          state: s,
          reply: self.priority ?? 'none',
        }),
        note: (s: number, _p: unknown, self: Node.Self) => ({
          state: s,
          reply: void (castSeen = self.priority ?? 'none'),
        }),
      },
    });
    assert.strictEqual(
      await unit.call('which', null, { priority: 'high' }),
      'high',
      'the local call carried its priority through the mailbox',
    );
    unit.cast('note', null, { priority: 'low' });
    await settle();
    assert.strictEqual(castSeen, 'low', 'the local cast carried its priority');
    node.stop();
  });
});
