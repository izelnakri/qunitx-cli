// A workerPool worker exercising the four Task-in-handler patterns. In test/fixtures (lint/check
// excluded). Pure: it `export`s a `worker` setup; the pool's bootstrap hands it to serveWorker().
// `ran` is worker-LOCAL — the main thread reads it back via the 'ran' handler, because a side effect
// on a worker thread isn't visible across the postMessage boundary.
import { Task } from '../../lib/task/index.ts';
import type { NodeHandle } from '../../lib/node/node.ts';

export function worker(node: NodeHandle) {
  let ran = 0;
  node.handle('ran', () => ran);
  node.handle('reset', () => void (ran = 0));

  // (e/i) return task
  node.handle('return-task', () =>
    Task(() => {
      ran += 1;
      return 'v';
    }),
  );
  node.handle('return-task-bad', () =>
    Task(() => {
      throw new Error('boom');
    }),
  );
  // (f/j) return await task
  node.handle(
    'return-await',
    async () =>
      await Task(() => {
        ran += 1;
        return 'v';
      }),
  );
  node.handle(
    'return-await-bad',
    async () =>
      await Task(() => {
        throw new Error('boom');
      }),
  );
  // (g/k) { task; return x } — created, never awaited (lazy → dropped)
  node.handle('drop-lazy', () => {
    Task(() => {
      ran += 1;
    });
    return 'x';
  });
  node.handle('drop-lazy-bad', () => {
    Task(() => {
      throw new Error('boom');
    });
    return 'x';
  });
  // (h/l) { await task; return x }
  node.handle('await-task', async () => {
    await Task(() => {
      ran += 1;
    });
    return 'x';
  });
  node.handle('await-task-bad', async () => {
    await Task(() => {
      throw new Error('boom');
    });
    return 'x';
  });
}
