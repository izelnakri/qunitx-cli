import { module, test } from 'qunitx';
import { memoryStore } from '../../lib/node/index.ts';
import { jobQueue } from '../../lib/jobs/index.ts';
import { Task } from '../../lib/task/index.ts';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// A job worker's return is AWAITED by the queue (`await worker(args)`), and a rejection marks the
// job failed (retryable → discarded). So: RETURN or AWAIT a Task → it runs and its error propagates,
// unchanged. CREATE-AND-DROP a Task → laziness decides: a lazy Task is a no-op (nothing triggered
// it); only an already-eager (performed) one runs — and then its outcome is orphaned.
module('Jobs | Task inside a worker handler', () => {
  test('(a) return task — the Task runs and its failure propagates to the job', async (assert) => {
    const ran: string[] = [];
    const jobs = jobQueue({
      store: memoryStore(),
      backoff: () => 0,
      workers: {
        ok: () => Task(() => (ran.push('a'), 'v')),
        bad: () =>
          Task(() => {
            throw new Error('boom');
          }),
      },
    });
    await jobs.insert('ok');
    const bad = await jobs.insert('bad', {}, { maxAttempts: 1 });
    await jobs.drain();
    assert.deepEqual(ran, ['a'], 'the returned Task RAN — the queue awaits the worker return');
    assert.equal(jobs.job(bad.id)?.state, 'discarded', 'and its error PROPAGATED — the job failed');
    jobs.stop();
  });

  test('(b) return await task — identical: runs, failure propagates', async (assert) => {
    const ran: string[] = [];
    const jobs = jobQueue({
      store: memoryStore(),
      backoff: () => 0,
      workers: {
        ok: async () => await Task(() => (ran.push('b'), 'v')),
        bad: async () =>
          await Task(() => {
            throw new Error('boom');
          }),
      },
    });
    await jobs.insert('ok');
    const bad = await jobs.insert('bad', {}, { maxAttempts: 1 });
    await jobs.drain();
    assert.deepEqual(ran, ['b'], 'await ran the Task');
    assert.equal(jobs.job(bad.id)?.state, 'discarded', 'the await threw → job failed');
    jobs.stop();
  });

  test('(c) create-and-drop — a LAZY task never runs; an EAGER one runs but is orphaned', async (assert) => {
    const ran: string[] = [];
    const jobs = jobQueue({
      store: memoryStore(),
      backoff: () => 0,
      workers: {
        lazy: () => {
          Task(() => ran.push('lazy')); // created, never awaited → lazy → dropped
          return 'v';
        },
        lazyBad: () => {
          Task(() => {
            throw new Error('boom');
          }); // dropped throwing lazy task
          return 'v';
        },
        eager: () => {
          Task(() => ran.push('eager')).perform(); // already performing → runs, but orphaned
          return 'v';
        },
      },
    });
    const lazyBad = await jobs.insert('lazyBad', {}, { maxAttempts: 1 });
    await jobs.insert('lazy');
    await jobs.insert('eager');
    await jobs.drain();
    await settle();
    assert.false(
      ran.includes('lazy'),
      'a dropped LAZY task never runs — laziness, nothing triggered it',
    );
    assert.true(
      ran.includes('eager'),
      'a dropped EAGER task DOES run (already performing) — but orphaned',
    );
    assert.equal(
      jobs.job(lazyBad.id),
      undefined,
      'the dropped throwing task never ran → the job SUCCEEDED (removed), no error propagated',
    );
    jobs.stop();
  });

  test('(d) await task; return something — runs, failure propagates, result discarded', async (assert) => {
    const ran: string[] = [];
    const jobs = jobQueue({
      store: memoryStore(),
      backoff: () => 0,
      workers: {
        ok: async () => {
          await Task(() => ran.push('d'));
          return 'x';
        },
        bad: async () => {
          await Task(() => {
            throw new Error('boom');
          });
          return 'x';
        },
      },
    });
    const ok = await jobs.insert('ok');
    const bad = await jobs.insert('bad', {}, { maxAttempts: 1 });
    await jobs.drain();
    assert.deepEqual(ran, ['d'], 'await triggered the Task');
    assert.equal(jobs.job(ok.id), undefined, 'the ok worker returned x and the job completed');
    assert.equal(
      jobs.job(bad.id)?.state,
      'discarded',
      'the await threw before the return → job failed',
    );
    jobs.stop();
  });
});
