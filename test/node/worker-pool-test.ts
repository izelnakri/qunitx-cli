import { module, test } from 'qunitx';
import { workerPool } from '../../lib/node/worker-pool.ts';

module('Node | workerPool (CPU parallelism across threads)', () => {
  test('round-robins CPU work across worker threads; the main loop stays responsive', async (assert) => {
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno — the node lane owns worker_threads');
      return;
    }
    const pool = workerPool({
      size: 3,
      module: new URL('../fixtures/cpu-worker.ts', import.meta.url),
      group: 'cpu',
    });
    try {
      await pool.ready();
      assert.equal(pool.node.groupMembers('cpu').length, 3, 'all three worker threads joined');

      // fan out six heavy computes — they run in parallel on the three threads
      const results = await Promise.all(
        [37, 37, 37, 37, 37, 37].map((n) => pool.call('fib', n, 20000)),
      );
      assert.true(
        results.every((r) => r === 24157817),
        'every fib(37) computed correctly across the pool',
      );

      // the whole point: a heavy compute runs on a worker, so the main loop keeps ticking
      let ticks = 0;
      const ticker = setInterval(() => (ticks += 1), 1);
      await pool.call('fib', 40, 20000);
      clearInterval(ticker);
      assert.true(ticks > 50, `main ticked ${ticks} times during the compute — not blocked`);
    } finally {
      await pool.stop();
    }
  });
});
