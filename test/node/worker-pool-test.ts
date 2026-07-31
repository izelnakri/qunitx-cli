import { module, test } from 'qunitx';
import { workerPool } from '../../lib/node/worker-pool.ts';
import { Node } from '../../lib/node/index.ts';
import { startHub } from '../../lib/node/hub.ts';
import { wsTransport } from '../../lib/node/ws.ts';

const CPU_WORKER = new URL('../fixtures/cpu-worker.ts', import.meta.url);
const until = async (cond: () => boolean, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
};

module('Node | workerPool (CPU parallelism across threads)', () => {
  test('round-robins CPU work across worker threads; the main loop stays responsive', async (assert) => {
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno — the node lane owns worker_threads');
      return;
    }
    const pool = workerPool({ size: 3, module: CPU_WORKER, group: 'cpu' });
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

  test('respawns a crashed worker thread — the pool keeps serving (supervised)', async (assert) => {
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno');
      return;
    }
    const pool = workerPool({ size: 3, module: CPU_WORKER, group: 'cpu' });
    try {
      await pool.ready();
      const victim = pool.node.groupMembers('cpu')[0];
      pool.node.cast(victim, 'crash'); // kill one worker thread

      // The slot respawns under its STABLE name (a fresh generation would leak a CRDT vv entry
      // per crash) — so watch for the group to first shrink (the crash dropped it) and then recover
      // to full size WITH the same name back. A respawn waits for cluster sync before rejoining, so
      // the dip is observable rather than instantaneous.
      let sawDrop = false;
      assert.true(
        await until(() => {
          const members = pool.node.groupMembers('cpu');
          if (!members.includes(victim)) sawDrop = true;
          return sawDrop && members.length === 3 && members.includes(victim);
        }),
        'the slot dropped on crash and respawned under its stable name — back to full size',
      );
      assert.equal(
        await pool.call('fib', 20, 20000),
        6765,
        'the pool still serves after the respawn',
      );
    } finally {
      await pool.stop();
    }
  });

  test('cluster mode: threads join a shared ws hub as a global group:cpu', async (assert) => {
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno');
      return;
    }
    const hub = startHub({ port: 0 });
    const url = `ws://localhost:${hub.port()}`;
    const app = Node.start('app@cluster', wsTransport(url)); // an ORDINARY cluster node, not the pool
    const pool = workerPool({ size: 2, module: CPU_WORKER, group: 'cpu', hub: url });
    try {
      await pool.ready();
      assert.true(
        await until(() => app.groupMembers('cpu').length === 2),
        'the app node sees the pool threads cluster-wide',
      );
      assert.equal(
        await app.call('group:cpu', 'fib', 20, 20000),
        6765,
        'any cluster node reaches the pool via the global group:cpu',
      );
    } finally {
      await pool.stop();
      app.stop();
      await hub.close();
    }
  });
});
