import { module, test } from 'qunitx';
import { start } from '../../lib/node/index.ts';
import { workerPool } from '../../lib/node/worker-pool.ts';
import { wsTransport } from '../../lib/node/ws.ts';
import { startHub } from '../../lib/node/hub.ts';
import { isFailure } from '../../lib/result/failure.ts';

const TASK_WORKER = new URL('../fixtures/task-worker.ts', import.meta.url);
const until = async (cond: () => boolean, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
};

// A worker handler's return is awaited by node.handle, which turns a rejection into a Failure/
// RemoteCrash reply. So across the wire: RETURN/AWAIT a Task → it runs (its VALUE crosses) and its
// error propagates as a Failure the caller's .result() surfaces. CREATE-AND-DROP a lazy Task → it
// never runs (nothing triggered it), so no value and no error. The handler TYPE doesn't change any
// of this; only the outcome (a value or a Failure) crosses, never the Task object.
async function assertPatterns(
  assert: Assert,
  call: (subject: string) => Promise<unknown> & { result(): Promise<unknown> },
) {
  const val = (s: string) => call(s) as Promise<unknown>;
  const failed = async (s: string) => isFailure(await call(s).result());

  await val('reset');
  // (e/i) return task
  assert.equal(
    await val('return-task'),
    'v',
    'return task → the Task ran; its VALUE crossed the wire',
  );
  assert.equal(await val('ran'), 1, 'the Task RAN on the worker (node.handle awaited the return)');
  assert.true(
    await failed('return-task-bad'),
    'return task error → PROPAGATED as a Failure over the wire',
  );

  await val('reset');
  // (f/j) return await task
  assert.equal(await val('return-await'), 'v', 'return await task → value crossed');
  assert.equal(await val('ran'), 1, 'return await → RAN');
  assert.true(await failed('return-await-bad'), 'return await error → propagated');

  await val('reset');
  // (g/k) { task; return x } — lazy, dropped
  assert.equal(await val('drop-lazy'), 'x', 'task; return x → returns x');
  assert.equal(await val('ran'), 0, 'a dropped LAZY task did NOT run — nothing triggered it');
  assert.false(
    await failed('drop-lazy-bad'),
    'a dropped throwing lazy task never ran → NO error propagated',
  );

  await val('reset');
  // (h/l) { await task; return x }
  assert.equal(await val('await-task'), 'x', 'await task; return x → returns x');
  assert.equal(await val('ran'), 1, 'await triggered the Task');
  assert.true(await failed('await-task-bad'), 'await task error → propagated');
}

module('Node | workerPool | Task inside a worker handler', () => {
  test('(e-h) LOCAL pool: return/await run + propagate; a dropped lazy task is a no-op', async (assert) => {
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno — the node lane owns worker_threads');
      return;
    }
    const pool = workerPool({ size: 1, module: TASK_WORKER, group: 'tk' });
    try {
      await pool.ready();
      await assertPatterns(assert, (s) => pool.call(s));
    } finally {
      await pool.stop();
    }
  });

  test('(i-l) CLUSTER pool: identical, addressed by a global group from another node', async (assert) => {
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno');
      return;
    }
    const hub = startHub({ port: 0 });
    const url = `ws://localhost:${hub.port()}`;
    const app = start('app@cluster', wsTransport(url)); // an ordinary cluster node, not the pool
    const pool = workerPool({ size: 1, module: TASK_WORKER, group: 'tk', hub: url });
    try {
      await pool.ready();
      assert.true(
        await until(() => app.groupMembers('tk').length === 1),
        'the worker joined the global group',
      );
      await assertPatterns(assert, (s) => app.call('group:tk', s));
    } finally {
      await pool.stop();
      app.stop();
      await hub.close();
    }
  });
});
