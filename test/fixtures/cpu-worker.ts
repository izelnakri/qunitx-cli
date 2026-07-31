// A workerPool worker module — runs inside a worker thread. In test/fixtures (lint/check excluded).
// Pure: it `export`s a `worker` setup; the pool's bootstrap hands it to serveWorker().
import type { NodeHandle } from '../../lib/node/node.ts';

export function worker(node: NodeHandle) {
  const fib = (n: number): number => (n < 2 ? n : fib(n - 1) + fib(n - 2));
  node.handle('fib', (payload) => fib(payload as number)); // CPU-heavy, on this thread
  node.handle('echo', (payload) => payload);
  node.handle('crash', () => void setTimeout(() => process.exit(1), 0)); // kill this worker thread
}
