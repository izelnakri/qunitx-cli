// The worker-thread bootstrap that {@link workerPool} spawns (by URL, via `__pool.module`): import the
// user's worker module and hand its exported `worker` setup to {@link serveWorker}. This is what lets a
// pool module stay PURE — `export function worker(node) { … }`, no top-level `serveWorker()` call and
// no side effects. Not a public symbol; nobody imports this file — the pool runs it as the thread entry.
import { workerData } from 'node:worker_threads';
import { serveWorker } from './worker-pool.ts';
import type { NodeHandle } from './node.ts';

// Guarded so importing this file OUTSIDE a pool worker (e.g. the doctest gate, which loads every lib
// module) is a harmless no-op rather than a crash on `workerData` being null.
const pool = (workerData as { __pool?: { module: string } } | null)?.__pool;
if (pool) {
  const loaded = (await import(pool.module)) as {
    worker?: (node: NodeHandle, data: unknown) => void;
  };
  if (typeof loaded.worker !== 'function') {
    throw new Error(`workerPool module ${pool.module} must \`export function worker(node) { … }\``);
  }
  serveWorker(loaded.worker);
}
