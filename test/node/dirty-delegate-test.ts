import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { workerPool, dirtyDelegate } from '../../lib/node/worker-pool.ts';

const CPU_WORKER = new URL('../fixtures/cpu-worker.ts', import.meta.url);

module('Node | dirtyDelegate (CPU offload to a pool thread)', () => {
  test('a delegated CPU subject computes on a thread, off the main loop', async (assert) => {
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno — worker_threads is the node lane');
      return;
    }
    const hub = Node.memoryHub();
    const gateway = Node.start('gw@dirty', hub.transport());
    const client = Node.start('cli@dirty', hub.transport());
    const pool = workerPool({ size: 2, module: CPU_WORKER, group: 'cpu' });
    try {
      await pool.ready();
      // The gateway exposes 'fib' but runs it on a pool thread rather than its own loop.
      dirtyDelegate(gateway, pool, ['fib']);

      // While a heavy compute runs, the main loop must keep ticking — proof it went to a thread.
      let ticks = 0;
      const ticker = setInterval(() => (ticks += 1), 1);
      const result = await client.call('gw@dirty', 'fib', 38, 20000);
      clearInterval(ticker);

      assert.strictEqual(result, 39088169, 'fib(38) computed on a pool thread');
      assert.true(ticks > 5, `the main loop ticked ${ticks}x during the compute — not blocked`);
    } finally {
      await pool.stop();
      gateway.stop();
      client.stop();
    }
  });
});
