import { module, test } from 'qunitx';
import { memoryStore } from '../../lib/node/index.ts';
import { jobQueue } from '../../lib/jobs/index.ts';
import { isFailure } from '../../lib/result/failure.ts';
import * as Telemetry from '../../lib/telemetry/index.ts';

module('Jobs | Oban-shaped durable queue', () => {
  test('a job executes, completes, and is removed — with telemetry', async (assert) => {
    const store = memoryStore();
    const done: unknown[] = [];
    const events: string[] = [];
    Telemetry.attachMany(
      'jobs-t1',
      [
        ['jobs', 'execute', 'start'],
        ['jobs', 'execute', 'stop'],
      ],
      (e) => void events.push(e.at(-1)!),
    );
    const jobs = jobQueue({ store, workers: { work: (args) => void done.push(args) } });

    const job = await jobs.insert('work', { n: 1 });
    await jobs.drain();
    Telemetry.detach('jobs-t1');
    assert.deepEqual(done, [{ n: 1 }]);
    assert.equal(
      jobs.job(job.id),
      undefined,
      'completed jobs are removed — the queue stays bounded',
    );
    assert.deepEqual(events, ['start', 'stop'], 'execution was instrumented');
    jobs.stop();
  });

  test('a failing job retries with backoff, then succeeds — attempts and errors on the record', async (assert) => {
    const store = memoryStore();
    let calls = 0;
    const jobs = jobQueue({
      store,
      workers: {
        flaky: () => {
          if (++calls < 3) throw new Error(`boom ${calls}`);
        },
      },
      backoff: () => 0, // retry immediately — deterministic tests
      pollMs: 10,
    });
    await jobs.insert('flaky');
    await jobs.drain();
    assert.equal(calls, 3, 'two failures, then the third attempt succeeded');
    jobs.stop();
  });

  test('maxAttempts exhausted → discarded, kept with its error history', async (assert) => {
    const store = memoryStore();
    const jobs = jobQueue({
      store,
      workers: {
        doomed: () => {
          throw new Error('always');
        },
      },
      backoff: () => 0,
      pollMs: 10,
    });
    const job = await jobs.insert('doomed', {}, { maxAttempts: 2 });
    await jobs.drain();
    const record = jobs.job(job.id)!;
    assert.equal(record.state, 'discarded', 'the dead-letter record survives');
    assert.equal(record.errors.length, 2, 'one error per attempt');
    assert.true(record.errors[0].error.includes('always'));
    jobs.stop();
  });

  test('scheduleIn: not before its time; runs after', async (assert) => {
    const store = memoryStore();
    const ran: number[] = [];
    const jobs = jobQueue({
      store,
      workers: { later: () => void ran.push(Date.now()) },
      pollMs: 10,
    });
    await jobs.insert('later', {}, { scheduleIn: 80 });
    await jobs.drain(); // drains what is runnable NOW — the scheduled job is not
    assert.deepEqual(ran, [], 'not executed before its time');
    await new Promise((r) => setTimeout(r, 120));
    await jobs.drain();
    assert.equal(ran.length, 1, 'executed once due');
    jobs.stop();
  });

  test('per-queue concurrency limits hold; priority 0 beats 9', async (assert) => {
    const store = memoryStore();
    let inFlight = 0;
    let peak = 0;
    const order: string[] = [];
    const jobs = jobQueue({
      store,
      queues: { mailers: 2 },
      workers: {
        mail: async (args) => {
          order.push((args as { tag: string }).tag);
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 20));
          inFlight--;
        },
      },
      pollMs: 5,
    });
    jobs.pauseQueue('mailers'); // stage everything first, then release — deterministic ordering
    await jobs.insert('mail', { tag: 'low' }, { queue: 'mailers', priority: 9 });
    await jobs.insert('mail', { tag: 'urgent' }, { queue: 'mailers', priority: 0 });
    for (let i = 0; i < 3; i++)
      await jobs.insert('mail', { tag: `bulk${i}` }, { queue: 'mailers', priority: 5 });
    jobs.resumeQueue('mailers');
    await jobs.drain();
    assert.equal(peak, 2, 'never more than the queue limit in flight');
    assert.equal(order[0], 'urgent', 'priority 0 ran first');
    assert.equal(order.at(-1), 'low', 'priority 9 ran last');
    jobs.stop();
  });

  test('unique inserts dedupe; cancelJob removes a pending job', async (assert) => {
    const store = memoryStore();
    const ran: unknown[] = [];
    const jobs = jobQueue({ store, workers: { once: (a) => void ran.push(a) }, pollMs: 10 });
    jobs.pauseQueue('default');
    const first = await jobs.insert('once', { key: 'x' }, { unique: true });
    const second = await jobs.insert('once', { key: 'x' }, { unique: true });
    assert.equal(second.id, first.id, 'the duplicate returned the existing job');

    const doomed = await jobs.insert('once', { key: 'y' });
    await jobs.cancelJob(doomed.id);
    jobs.resumeQueue('default');
    await jobs.drain();
    assert.deepEqual(ran, [{ key: 'x' }], 'deduped ran once; cancelled never ran');
    jobs.stop();
  });

  test('crash rescue: a job left `executing` by a dead process runs again on reload', async (assert) => {
    const store = memoryStore(); // the SHARED durable store (Postgres in production)
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const first = jobQueue({
      store,
      workers: { task: () => gate }, // never finishes — the "process" dies mid-attempt
      pollMs: 10,
    });
    const job = await first.insert('task', { payload: 7 });
    const deadline = Date.now() + 2000;
    while (first.job(job.id)?.state !== 'executing' && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    first.stop(); // the process crashes — the job is stranded as `executing` in the store
    release();

    const done: unknown[] = [];
    const second = jobQueue({ store, workers: { task: (a) => void done.push(a) }, pollMs: 10 });
    await second.drain();
    assert.deepEqual(done, [{ payload: 7 }], 'the orphaned job was rescued and completed');
    second.stop();
  });

  test('insert returns an eager Task — a real Promise, and .result() gives the bare union', async (assert) => {
    const store = memoryStore();
    const jobs = jobQueue({ store, workers: { 'reports.export': () => 'ok' } });
    jobs.pauseQueue('default'); // keep jobs enqueued (instant workers would run+remove them)

    const handle = jobs.insert('reports.export', { n: 1 });
    assert.true(
      handle instanceof Promise,
      'a Task IS a Promise — a drop-in for the old return type (so `await`/`.then` just work)',
    );
    assert.equal(
      typeof handle.result,
      'function',
      'and it is genuinely a Task, not a bare Promise — `.result()`/`.perform()` are present',
    );
    const job = await handle;
    assert.true(
      jobs.job(job.id) !== undefined,
      'the insert was eager — the job is already enqueued',
    );

    // the uniformity win: .result() settles to the bare Result union (Job | Failure) — no try/catch;
    // isFailure() is the discriminator. (insert only fails on a store write error; here it succeeds.)
    const outcome = await jobs.insert('reports.export', { n: 2 }).result();
    assert.false(isFailure(outcome), 'a successful insert resolves to the Job, not a Failure');
    assert.deepEqual(
      (outcome as { args: unknown }).args,
      { n: 2 },
      'the enqueued Job came back through result() — carrying its data',
    );

    jobs.resumeQueue('default');
    await jobs.drain();
    jobs.stop();
  });

  test('multi-node: two drainers on ONE store split the work, never double-run (atomic claim)', async (assert) => {
    const store = memoryStore(); // one shared store; two independent queue instances, both active
    const ranBy: Record<string, string> = {}; // jobId -> node that ran it, or 'DUP' if two did
    const make = (node: string) =>
      jobQueue({
        store,
        pollMs: 5,
        queues: { default: 3 }, // each runs at most 3 at once — neither can grab all 12
        workers: {
          work: async (a) => {
            const id = (a as { id: string }).id;
            ranBy[id] = ranBy[id] ? 'DUP' : node;
            await new Promise((r) => setTimeout(r, 25));
          },
        },
      });
    const a = make('A');
    const b = make('B');
    for (let i = 0; i < 12; i++) await a.insert('work', { id: `j${i}` });

    await Promise.all([a.drain(), b.drain()]); // both drain concurrently — no leader election
    const outcomes = Object.values(ranBy);
    assert.equal(Object.keys(ranBy).length, 12, 'every job ran exactly once');
    assert.equal(
      outcomes.filter((v) => v === 'DUP').length,
      0,
      'no job ran twice — the claim is atomic',
    );
    assert.true(
      outcomes.includes('A') && outcomes.includes('B'),
      'both nodes drained a share — SKIP-LOCKED-style, no singleton',
    );
    a.stop();
    b.stop();
  });
});
