import { module, test } from 'qunitx';
import { start, memoryHub } from '../../lib/node/index.ts';
import { Task } from '../../lib/task/index.ts';
import { isFailure } from '../../lib/result/failure.ts';

// The specific-node case (m-p): `client.call('server@c', subject)` addressed to ONE named node,
// not a group. node.handle awaits the handler's return, so the same rule holds as everywhere:
// RETURN/AWAIT a Task → it runs and its error crosses back as a Failure; a dropped LAZY task is a
// no-op. In-process nodes share one memoryHub, so the handler's side effect lands in a shared `ran`
// array we can read directly — no counter round-trip needed. Runs on BOTH lanes (no worker threads).
module('Node | specific node | Task inside a handler', () => {
  test('(m-p) return/await run + propagate; a dropped lazy task is a no-op', async (assert) => {
    const hub = memoryHub();
    const ran: string[] = [];
    const server = start('server@c', hub.transport());
    const client = start('client@c', hub.transport());

    server.handle('return-task', () => Task(() => (ran.push('m'), 'v')));
    server.handle('return-task-bad', () =>
      Task(() => {
        throw new Error('boom');
      }),
    );
    server.handle('return-await', async () => await Task(() => (ran.push('n'), 'v')));
    server.handle(
      'return-await-bad',
      async () =>
        await Task(() => {
          throw new Error('boom');
        }),
    );
    server.handle('drop-lazy', () => (Task(() => ran.push('o')), 'x'));
    server.handle(
      'drop-lazy-bad',
      () => (
        Task(() => {
          throw new Error('boom');
        }),
        'x'
      ),
    );
    server.handle('await-task', async () => {
      await Task(() => ran.push('p'));
      return 'x';
    });
    server.handle('await-task-bad', async () => {
      await Task(() => {
        throw new Error('boom');
      });
      return 'x';
    });

    const call = (s: string) => client.call('server@c', s);
    try {
      // (m) return task
      assert.equal(await call('return-task'), 'v', 'return task → value crossed back');
      assert.true(ran.includes('m'), 'the returned Task RAN on the server node');
      assert.true(
        isFailure(await call('return-task-bad').result()),
        'return task error → PROPAGATED as a Failure',
      );

      // (n) return await task
      assert.equal(await call('return-await'), 'v', 'return await task → value crossed');
      assert.true(ran.includes('n'), 'return await → RAN');
      assert.true(
        isFailure(await call('return-await-bad').result()),
        'return await error → propagated',
      );

      // (o) { task; return x } — dropped lazy
      assert.equal(await call('drop-lazy'), 'x', 'task; return x → returns x');
      assert.false(ran.includes('o'), 'a dropped LAZY task did NOT run — nothing triggered it');
      assert.false(
        isFailure(await call('drop-lazy-bad').result()),
        'a dropped throwing lazy task never ran → NO error propagated',
      );

      // (p) { await task; return x }
      assert.equal(await call('await-task'), 'x', 'await task; return x → returns x');
      assert.true(ran.includes('p'), 'await triggered the Task');
      assert.true(
        isFailure(await call('await-task-bad').result()),
        'await task error → propagated',
      );
    } finally {
      client.stop();
      server.stop();
    }
  });
});
