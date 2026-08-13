import { module, test } from 'qunitx';
import { Node } from '../../lib/node/index.ts';
import { workerPool } from '../../lib/node/worker-pool.ts';
import { wsTransport } from '../../lib/node/ws.ts';
import { startHub } from '../../lib/node/hub.ts';
import { Failure } from '../../lib/result/index.ts';

const TASK_WORKER = new URL('../fixtures/task-worker.ts', import.meta.url);
const until = async (cond: () => boolean, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
};

// A worker handler's return is awaited by node.handle, so the Task rule holds across the wire:
// RETURN/AWAIT a Task → it runs (its VALUE crosses) and, on failure, `.result()` surfaces a Failure;
// a CREATED-AND-DROPPED lazy Task never runs. The fixture's bad handlers throw a plain
// `new Error('boom')`, so a failure crosses back as a RemoteCrash Failure — never the raw Error:
// code 'RemoteCrash', the original text in the message, tagged with the subject. `ran` is worker-LOCAL
// (a side effect can't cross the postMessage boundary), so the fixture exposes a 'ran' counter + a
// 'reset' we read back between shapes. Nothing here throws (good calls resolve, failing ones read via
// `.result()`), so each test just cleans up at the end.
module('Node | workerPool | Task inside a worker handler', () => {
  test('(e-h) LOCAL pool: return/await run + propagate; a dropped lazy task is a no-op', async (assert) => {
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno — the node lane owns worker_threads');
      return;
    }
    const pool = workerPool({ size: 1, module: TASK_WORKER, group: 'tk' });
    await pool.ready();

    await pool.call('reset');
    // (e) return task — the Task runs (its value crosses); a throw crosses as a RemoteCrash Failure.
    assert.equal(
      await pool.call('return-task'),
      'v',
      'return task → the Task ran; its VALUE crossed the wire',
    );
    assert.equal(
      await pool.call('ran'),
      1,
      'the Task RAN on the worker (node.handle awaited the return)',
    );
    const returnTaskBad = (await pool.call('return-task-bad').result()) as Failure.Any;
    assert.true(
      Failure.is(returnTaskBad),
      'return-task-bad → its error propagated as a Failure over the wire',
    );
    assert.equal(returnTaskBad.code, 'RemoteCrash', 'a raw worker throw crosses as RemoteCrash');
    assert.true(
      String(returnTaskBad.message).includes('boom'),
      'the original error text is preserved',
    );
    assert.deepEqual(
      returnTaskBad.data,
      { subject: 'return-task-bad' },
      'RemoteCrash tags the subject',
    );

    await pool.call('reset');
    // (f) return await task — identical.
    assert.equal(await pool.call('return-await'), 'v', 'return await task → value crossed');
    assert.equal(await pool.call('ran'), 1, 'return await → RAN');
    const returnAwaitBad = (await pool.call('return-await-bad').result()) as Failure.Any;
    assert.true(Failure.is(returnAwaitBad), 'return-await-bad → propagated a Failure');
    assert.equal(returnAwaitBad.code, 'RemoteCrash', 'a raw throw crosses as RemoteCrash');
    assert.true(
      String(returnAwaitBad.message).includes('boom'),
      'the original error text is preserved',
    );
    assert.deepEqual(
      returnAwaitBad.data,
      { subject: 'return-await-bad' },
      'RemoteCrash tags the subject',
    );

    await pool.call('reset');
    // (g) { task; return x } — the lazy Task is dropped, so it never runs and nothing propagates.
    assert.equal(await pool.call('drop-lazy'), 'x', 'task; return x → returns x');
    assert.equal(
      await pool.call('ran'),
      0,
      'the dropped LAZY task did NOT run — nothing triggered it',
    );
    assert.false(
      Failure.is(await pool.call('drop-lazy-bad').result()),
      'the dropped throwing lazy task never ran → the call SUCCEEDED, no Failure crossed back',
    );

    await pool.call('reset');
    // (h) { await task; return x } — the await runs the Task; a throw short-circuits the return.
    assert.equal(await pool.call('await-task'), 'x', 'await task; return x → returns x');
    assert.equal(await pool.call('ran'), 1, 'await triggered the Task');
    const awaitTaskBad = (await pool.call('await-task-bad').result()) as Failure.Any;
    assert.true(Failure.is(awaitTaskBad), 'await-task-bad → propagated a Failure');
    assert.equal(awaitTaskBad.code, 'RemoteCrash', 'a raw throw crosses as RemoteCrash');
    assert.true(
      String(awaitTaskBad.message).includes('boom'),
      'the original error text is preserved',
    );
    assert.deepEqual(
      awaitTaskBad.data,
      { subject: 'await-task-bad' },
      'RemoteCrash tags the subject',
    );

    await pool.stop();
  });

  test('(i-l) CLUSTER pool: identical, addressed by a global group from another node', async (assert) => {
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno');
      return;
    }
    const hub = startHub({ port: 0 });
    const url = `ws://localhost:${hub.port()}`;
    const app = Node.start('app@cluster', wsTransport(url)); // an ordinary cluster node, not the pool
    const pool = workerPool({ size: 1, module: TASK_WORKER, group: 'tk', hub: url });
    await pool.ready();
    assert.true(
      await until(() => app.groupMembers('tk').length === 1),
      'the worker joined the global group',
    );

    await app.call('group:tk', 'reset');
    // (i) return task — routed to the worker by global group; a throw crosses back as RemoteCrash.
    assert.equal(
      await app.call('group:tk', 'return-task'),
      'v',
      'return task → the Task ran; its VALUE crossed the wire',
    );
    assert.equal(await app.call('group:tk', 'ran'), 1, 'the Task RAN on the worker');
    const returnTaskBad = (await app.call('group:tk', 'return-task-bad').result()) as Failure.Any;
    assert.true(
      Failure.is(returnTaskBad),
      'return-task-bad → its error propagated as a Failure over the wire',
    );
    assert.equal(returnTaskBad.code, 'RemoteCrash', 'a raw worker throw crosses as RemoteCrash');
    assert.true(
      String(returnTaskBad.message).includes('boom'),
      'the original error text is preserved',
    );
    assert.deepEqual(
      returnTaskBad.data,
      { subject: 'return-task-bad' },
      'RemoteCrash tags the subject',
    );

    await app.call('group:tk', 'reset');
    // (j) return await task — identical.
    assert.equal(
      await app.call('group:tk', 'return-await'),
      'v',
      'return await task → value crossed',
    );
    assert.equal(await app.call('group:tk', 'ran'), 1, 'return await → RAN');
    const returnAwaitBad = (await app.call('group:tk', 'return-await-bad').result()) as Failure.Any;
    assert.true(Failure.is(returnAwaitBad), 'return-await-bad → propagated a Failure');
    assert.equal(returnAwaitBad.code, 'RemoteCrash', 'a raw throw crosses as RemoteCrash');
    assert.true(
      String(returnAwaitBad.message).includes('boom'),
      'the original error text is preserved',
    );
    assert.deepEqual(
      returnAwaitBad.data,
      { subject: 'return-await-bad' },
      'RemoteCrash tags the subject',
    );

    await app.call('group:tk', 'reset');
    // (k) { task; return x } — the lazy Task is dropped, so it never runs and nothing propagates.
    assert.equal(await app.call('group:tk', 'drop-lazy'), 'x', 'task; return x → returns x');
    assert.equal(
      await app.call('group:tk', 'ran'),
      0,
      'the dropped LAZY task did NOT run — nothing triggered it',
    );
    assert.false(
      Failure.is(await app.call('group:tk', 'drop-lazy-bad').result()),
      'the dropped throwing lazy task never ran → the call SUCCEEDED, no Failure crossed back',
    );

    await app.call('group:tk', 'reset');
    // (l) { await task; return x } — the await runs the Task; a throw short-circuits the return.
    assert.equal(await app.call('group:tk', 'await-task'), 'x', 'await task; return x → returns x');
    assert.equal(await app.call('group:tk', 'ran'), 1, 'await triggered the Task');
    const awaitTaskBad = (await app.call('group:tk', 'await-task-bad').result()) as Failure.Any;
    assert.true(Failure.is(awaitTaskBad), 'await-task-bad → propagated a Failure');
    assert.equal(awaitTaskBad.code, 'RemoteCrash', 'a raw throw crosses as RemoteCrash');
    assert.true(
      String(awaitTaskBad.message).includes('boom'),
      'the original error text is preserved',
    );
    assert.deepEqual(
      awaitTaskBad.data,
      { subject: 'await-task-bad' },
      'RemoteCrash tags the subject',
    );

    await pool.stop();
    app.stop();
    await hub.close();
  });
});
