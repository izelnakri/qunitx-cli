// A workerPool worker exercising the four Task-in-handler patterns. In test/fixtures (lint/check
// excluded). `ran` is worker-LOCAL — the main thread reads it back via the 'ran' handler, because a
// side effect on a worker thread isn't visible across the postMessage boundary.
import { serveWorker } from '../../lib/node/worker-pool.ts';
import { Task } from '../../lib/task/index.ts';

let ran = 0;

serveWorker((node) => {
  node.handle('ran', () => ran);
  node.handle('reset', () => void (ran = 0));

  // return task
  node.handle('return-task', () => Task(() => ((ran += 1), 'v')));
  node.handle('return-task-bad', () =>
    Task(() => {
      throw new Error('boom');
    }),
  );
  // return await task
  node.handle('return-await', async () => await Task(() => ((ran += 1), 'v')));
  node.handle(
    'return-await-bad',
    async () =>
      await Task(() => {
        throw new Error('boom');
      }),
  );
  // { task; return x } — created, never awaited (lazy → dropped)
  node.handle('drop-lazy', () => (Task(() => (ran += 1)), 'x'));
  node.handle(
    'drop-lazy-bad',
    () => (
      Task(() => {
        throw new Error('boom');
      }),
      'x'
    ),
  );
  // { await task; return x }
  node.handle('await-task', async () => {
    await Task(() => (ran += 1));
    return 'x';
  });
  node.handle('await-task-bad', async () => {
    await Task(() => {
      throw new Error('boom');
    });
    return 'x';
  });
});
