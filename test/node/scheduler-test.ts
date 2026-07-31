import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { Process } from '../../lib/node/process.ts';
import { yieldToLoop, yieldWith } from '../../lib/node/scheduler.ts';

// The cooperative scheduler gives BEAM-style fairness on the event loop: a flood of messages on one
// actor can't monopolize the loop, because the mailbox pump yields its slice after a reduction budget
// — so timers, I/O, and latency-sensitive actors keep getting serviced. Timers are the honest signal:
// a macrotask flood freezes them; the reduction-budgeted pump lets them fire.
module('Node | cooperative scheduler', () => {
  test('yieldToLoop yields a MACROtask — queued microtasks drain first', async (assert) => {
    const order: string[] = [];
    queueMicrotask(() => order.push('micro'));
    Promise.resolve().then(() => order.push('promise'));
    await yieldToLoop();
    order.push('after-yield');
    assert.deepEqual(
      order,
      ['micro', 'promise', 'after-yield'],
      'both microtasks ran before the macrotask resumed',
    );
  });

  test('yieldWith resumes in priority order within one tick', async (assert) => {
    const order: string[] = [];
    // Park all three in the same macrotask tick; they must wake HIGH → NORMAL → LOW regardless of
    // the order they parked in.
    const low = yieldWith('low').then(() => order.push('low'));
    const normal = yieldWith('normal').then(() => order.push('normal'));
    const high = yieldWith('high').then(() => order.push('high'));
    await Promise.all([low, normal, high]);
    assert.deepEqual(order, ['high', 'normal', 'low'], 'higher priority resumed first');
  });

  test('a 100k-message flood does NOT freeze timers (the pump yields its slice)', async (assert) => {
    const hub = Node.memoryHub();
    const busy = Node.start('busy@sched', hub.transport());
    const flooder = Node.genServer(busy, 'flood', {
      version: '1',
      init: () => 0,
      handlers: { work: (n: number) => ({ state: n + 1, reply: n }) },
    });

    // 100k messages — far past the reduction budget, so the pump MUST yield mid-drain.
    for (let i = 0; i < 100_000; i += 1) flooder.cast('work');

    // A timer scheduled right after the flood. A timer is a MACROtask, so a microtask-only pump would
    // hold it frozen until all 100k drain; the reduction-budgeted pump hands the loop back within a
    // slice, so it fires promptly. This is the fairness guarantee, measured — not luck.
    const t0 = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const latency = performance.now() - t0;
    assert.true(
      latency < 250,
      `a setTimeout(0) fired in ${latency.toFixed(1)}ms under a 100k flood — the loop stayed live`,
    );

    busy.stop();
  });

  test('Process.yield keeps a long single handler from blocking the loop', async (assert) => {
    const hub = Node.memoryHub();
    const node = Node.start('yield@sched', hub.transport());

    // A handler doing a big in-loop computation, yielding every 500 iterations. While it runs, a
    // setInterval ticker must keep firing — proof the loop was handed back mid-handler. Without the
    // yield the whole 50k loop is one synchronous, timer-freezing burst.
    let ticks = 0;
    const ticker = setInterval(() => (ticks += 1), 1);
    const worker = Node.genServer(node, 'reindex', {
      version: '1',
      init: () => 0,
      handlers: {
        run: async (_state: number, count: number) => {
          let done = 0;
          for (let i = 0; i < count; i += 1) {
            done += 1;
            if (done % 500 === 0) await Process.yield(); // give the loop back periodically
          }
          return { state: done, reply: done };
        },
      },
    });
    const processed = await worker.call('run', 50_000, 5000);
    clearInterval(ticker);
    assert.strictEqual(processed, 50_000, 'the handler completed all its work');
    assert.true(ticks >= 3, `the ticker fired ${ticks}× during the handler — the loop stayed live`);

    node.stop();
  });

  test('a below-budget mailbox drains with no yield (no latency added to the common case)', async (assert) => {
    // Under the reduction budget nothing yields — a normal, small mailbox behaves exactly as before,
    // draining in order within the same turn. This guards against a latency regression for the 99%.
    const hub = Node.memoryHub();
    const node = Node.start('small@sched', hub.transport());
    const seen: number[] = [];
    const unit = Node.genServer(node, 'seq', {
      version: '1',
      init: () => 0,
      handlers: { push: (n: number, v: number) => (seen.push(v), { state: n, reply: v }) },
    });
    const replies = await Promise.all([
      unit.call('push', 1),
      unit.call('push', 2),
      unit.call('push', 3),
    ]);
    assert.deepEqual(replies, [1, 2, 3], 'ordered replies');
    assert.deepEqual(
      seen,
      [1, 2, 3],
      'processed strictly in order, no reordering from the scheduler',
    );
    node.stop();
  });
});
