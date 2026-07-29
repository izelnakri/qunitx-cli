// A workerPool worker module — runs inside a worker thread. In test/fixtures (lint/check excluded).
import { serveWorker } from '../../lib/node/worker-pool.ts';

serveWorker((node) => {
  const fib = (n: number): number => (n < 2 ? n : fib(n - 1) + fib(n - 2));
  node.handle('fib', (payload) => fib(payload as number)); // CPU-heavy, on this thread
  node.handle('echo', (payload) => payload);
  node.handle('crash', () => void setTimeout(() => process.exit(1), 0)); // kill this worker thread
});
