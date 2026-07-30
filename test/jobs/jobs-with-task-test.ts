import { module, test } from 'qunitx';
import { memoryStore } from '../../lib/node/index.ts';
import { jobQueue, type JobQueue } from '../../lib/jobs/index.ts';
import { Task } from '../../lib/task/index.ts';
import { isFailure, define } from '../../lib/result/failure.ts';

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// A declared failure — the kind a worker throws on purpose (its code + data are captured for
// dead-letter routing); contrast with a raw `new Error(...)`, which is a *bug*.
const Overloaded = define(
  'Overloaded',
  (d: { retryAfter: number }) => `overloaded, retry in ${d.retryAfter}s`,
);
const lastError = (jobs: JobQueue, id: string) => jobs.job(id)?.errors.at(-1)?.error;

// A job worker's return is AWAITED by the queue (`await worker(args)`), and a rejection marks the
// job failed (retryable → discarded). So: RETURN or AWAIT a Task → it runs and its error propagates,
// unchanged. CREATE-AND-DROP a Task → laziness decides: a lazy Task is a no-op (nothing triggered
// it); only an already-eager (performed) one runs — and then its outcome is orphaned.
//
// Task rejects with the RAW thrown value (task.ts catches → #reject(error), no coercion), so the
// error the queue records is exactly what the worker threw: a raw Error is coerced to an `Unknown`
// Failure (original in `.cause`); a thrown `Failure` stays that Failure (code + data intact).
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
        typed: () =>
          Task(() => {
            throw Overloaded({ retryAfter: 5 });
          }),
      },
    });
    await jobs.insert('ok');
    const bad = await jobs.insert('bad', {}, { maxAttempts: 1 });
    const typed = await jobs.insert('typed', {}, { maxAttempts: 1 });
    await jobs.drain();
    assert.deepEqual(ran, ['a'], 'the returned Task RAN — the queue awaits the worker return');
    assert.equal(jobs.job(bad.id)?.state, 'discarded', 'and its error PROPAGATED — the job failed');

    const rawError = lastError(jobs, bad.id);
    assert.true(isFailure(rawError), 'a raw Error propagates through the Task as a live Failure');
    assert.equal(rawError?.code, 'Unknown', 'a bug is coerced to code Unknown');
    assert.true(
      String((rawError?.cause as Error)?.message).includes('boom'),
      'with the original Error preserved in .cause',
    );

    const typedError = lastError(jobs, typed.id);
    assert.true(isFailure(typedError), 'a thrown Failure stays a live Failure');
    assert.equal(typedError?.code, 'Overloaded', 'a declared Failure keeps its code');
    assert.deepEqual(typedError?.data, { retryAfter: 5 }, 'and its data survives');
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
        typed: async () =>
          await Task(() => {
            throw Overloaded({ retryAfter: 5 });
          }),
      },
    });
    await jobs.insert('ok');
    const bad = await jobs.insert('bad', {}, { maxAttempts: 1 });
    const typed = await jobs.insert('typed', {}, { maxAttempts: 1 });
    await jobs.drain();
    assert.deepEqual(ran, ['b'], 'await ran the Task');
    assert.equal(jobs.job(bad.id)?.state, 'discarded', 'the await threw → job failed');

    const rawError = lastError(jobs, bad.id);
    assert.true(isFailure(rawError), 'a raw Error propagates as a live Failure');
    assert.equal(rawError?.code, 'Unknown', 'a bug is coerced to code Unknown');
    assert.true(
      String((rawError?.cause as Error)?.message).includes('boom'),
      'with the original Error preserved in .cause',
    );

    const typedError = lastError(jobs, typed.id);
    assert.true(isFailure(typedError), 'a thrown Failure stays a live Failure');
    assert.equal(typedError?.code, 'Overloaded', 'a declared Failure keeps its code');
    assert.deepEqual(typedError?.data, { retryAfter: 5 }, 'and its data survives');
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
            throw Overloaded({ retryAfter: 5 }); // even a DECLARED failure, dropped lazily, never fires
          });
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
      'the dropped throwing task never ran → the job SUCCEEDED (removed); not even a Failure escapes a dropped lazy Task',
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
        typed: async () => {
          await Task(() => {
            throw Overloaded({ retryAfter: 5 });
          });
          return 'x';
        },
      },
    });
    const okJob = await jobs.insert('ok');
    const bad = await jobs.insert('bad', {}, { maxAttempts: 1 });
    const typed = await jobs.insert('typed', {}, { maxAttempts: 1 });
    await jobs.drain();
    assert.deepEqual(ran, ['d'], 'await triggered the Task');
    assert.equal(jobs.job(okJob.id), undefined, 'the ok worker returned x and the job completed');
    assert.equal(
      jobs.job(bad.id)?.state,
      'discarded',
      'the await threw before the return → job failed',
    );

    const rawError = lastError(jobs, bad.id);
    assert.true(isFailure(rawError), 'a raw Error propagates as a live Failure');
    assert.equal(rawError?.code, 'Unknown', 'a bug is coerced to code Unknown');
    assert.true(
      String((rawError?.cause as Error)?.message).includes('boom'),
      'with the original Error preserved in .cause',
    );

    const typedError = lastError(jobs, typed.id);
    assert.true(isFailure(typedError), 'a thrown Failure stays a live Failure');
    assert.equal(typedError?.code, 'Overloaded', 'a declared Failure keeps its code');
    assert.deepEqual(typedError?.data, { retryAfter: 5 }, 'and its data survives');
    jobs.stop();
  });
});
