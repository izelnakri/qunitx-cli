// preemption-demo.mjs — what "no preemptive scheduling" actually costs, measured against
// the real Node module. Run: node preemption-demo.mjs
import * as Node from '../../lib/node/index.ts';

const now = () => performance.now();
const hub = Node.memoryHub();

// One node, two independent services + a heartbeat — the shape of a real actor system.
const svc = Node.start('svc@demo', hub.transport());
const client = Node.start('client@demo', hub.transport());

// Service A: a normal, fast handler. In BEAM this would answer in microseconds no matter
// what else the VM is doing.
Node.serve(svc, 'orders', {
  version: '1',
  init: () => 0,
  handlers: { status: (s) => ({ state: s, reply: 'orders OK' }) },
});

// Service B: ONE handler with a CPU-bound body — a fat JSON.parse, a sync crypto hash, an
// unbounded loop. Nothing exotic; this is a Tuesday bug.
Node.serve(svc, 'reports', {
  version: '1',
  init: () => 0,
  handlers: {
    generate: (s) => {
      const deadline = now() + 2000; // 2s of synchronous CPU — stands in for real work
      let x = 0;
      while (now() < deadline) x += Math.sqrt(x + 1); // the loop that owns the thread
      return { state: s, reply: `report done (${x.toFixed(0)})` };
    },
  },
});

// A heartbeat watching a peer — this is supposed to tick every 100ms.
let lastTick = now();
const gaps = [];
const beat = setInterval(() => {
  gaps.push(now() - lastTick);
  lastTick = now();
}, 100);

await new Promise((r) => setTimeout(r, 50)); // let hellos settle

console.log('--- firing the slow report, then immediately asking orders for status ---');
const t0 = now();

// Fire the CPU-bound call; DON'T await it yet.
const slow = client.call('svc@demo', 'reports.generate', null);

// Immediately ask the OTHER, unrelated, fast service for status.
const fastStart = now();
const fast = client.call('svc@demo', 'orders.status', null);

const fastReply = await fast;
const fastLatency = now() - fastStart;
const slowReply = await slow;

clearInterval(beat);

console.log(`\nfast 'orders.status' reply: "${fastReply}"`);
console.log(`  it took ${fastLatency.toFixed(0)}ms to answer a HELLO-WORLD request`);
console.log(`  (in BEAM: ~0ms — orders never noticed reports was busy)\n`);
console.log(`slow 'reports.generate' reply: "${slowReply}"`);
console.log(`\nheartbeat gaps (should all be ~100ms):`);
console.log(`  ${gaps.map((g) => g.toFixed(0)).join('ms, ')}ms`);
const worst = Math.max(...gaps);
console.log(`  worst gap: ${worst.toFixed(0)}ms — the heartbeat FROZE for ${(worst / 100).toFixed(0)} missed ticks`);
console.log(`\nThe verdict: one CPU-bound handler in ONE service froze the ENTIRE node —`);
console.log(`the other service, the heartbeat, and (not shown) the supervisor and transport too.`);

svc.stop();
client.stop();
