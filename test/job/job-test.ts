import { module, test } from 'qunitx';
import { memoryStore } from '../../lib/node/index.ts';
import { Job } from '../../lib/job/index.ts';
import { Failure } from '../../lib/result/index.ts';
import * as Telemetry from '../../lib/telemetry/index.ts';

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

module('Jobs | Oban-shaped durable queue', () => {
  test('a job executes, completes, and is removed — with telemetry', async (assert) => {
    const done: unknown[] = [];
    const events: string[] = [];
    Telemetry.attachMany(
      'jobs-t1',
      [
        ['jobs', 'execute', 'start'],
        ['jobs', 'execute', 'stop'],
      ],
      (event) => void events.push(event.at(-1)!),
    );
    const queue = Job.queue({
      store: memoryStore(),
      workers: { work: (args) => void done.push(args) },
    });

    const job = await queue.insert('work', { n: 1 });
    await queue.drain();
    Telemetry.detach('jobs-t1');
    assert.deepEqual(done, [{ n: 1 }]);
    assert.equal(
      queue.peek(job.id),
      undefined,
      'a completed job is removed — the queue stays bounded',
    );
    assert.deepEqual(events, ['start', 'stop'], 'execution was instrumented');
    queue.stop();
  });

  test('a failing job retries with backoff, then succeeds — attempts and errors on the record', async (assert) => {
    let calls = 0;
    const queue = Job.queue({
      store: memoryStore(),
      workers: {
        flaky: () => {
          if (++calls < 3) throw new Error(`boom ${calls}`);
        },
      },
      backoff: () => 0, // retry immediately — deterministic tests
      pollMs: 10,
    });
    const job = await queue.insert('flaky');
    await queue.drain();
    assert.equal(calls, 3, 'two failures, then the third attempt succeeded');
    assert.equal(
      queue.peek(job.id),
      undefined,
      'the succeeded job is removed — no dead-letter left behind',
    );
    queue.stop();
  });

  test('maxAttempts exhausted → discarded, kept with its error history', async (assert) => {
    const queue = Job.queue({
      store: memoryStore(),
      workers: {
        doomed: () => {
          throw new Error('always');
        },
      },
      backoff: () => 0,
      pollMs: 10,
    });
    const job = await queue.insert('doomed', {}, { maxAttempts: 2 });
    await queue.drain();
    const discardedJob = queue.peek(job.id)!;
    assert.equal(
      discardedJob.state,
      'discarded',
      'the dead-letter record survives in state `discarded`',
    );
    assert.equal(discardedJob.attempt, 2, 'it stopped at exactly maxAttempts attempts');
    assert.equal(discardedJob.errors.length, 2, 'one error per attempt');
    assert.equal(discardedJob.errors[0].error.code, 'Unknown', 'a bug is coerced to a Failure');
    assert.equal(
      discardedJob.errors[0].error.message,
      'always',
      'its message is the original error text',
    );
    assert.true(
      String((discardedJob.errors[0].error.cause as Error)?.message).includes('always'),
      'the original error preserved in .cause',
    );
    queue.stop();
  });

  test('errors capture the stack; a thrown Failure adds its code + safe data, a bad payload is dropped', async (assert) => {
    const RateLimited = Failure.define(
      'RateLimited',
      (d: { retryAfter: number }) => `slow down (${d.retryAfter}s)`,
    );
    const queue = Job.queue({
      store: memoryStore(),
      backoff: () => 0,
      pollMs: 10,
      workers: {
        typed: () => {
          throw RateLimited({ retryAfter: 30 });
        },
        plain: () => {
          throw new Error('kaboom');
        },
        bad: () => {
          const cyclic: Record<string, unknown> = { retryAfter: 1 };
          cyclic.self = cyclic; // non-serializable data (a cycle)
          throw RateLimited(cyclic as { retryAfter: number });
        },
      },
    });
    const typed = await queue.insert('typed', {}, { maxAttempts: 1 });
    const plain = await queue.insert('plain', {}, { maxAttempts: 1 });
    const bad = await queue.insert('bad', {}, { maxAttempts: 1 });
    await queue.drain();

    const typedError = queue.peek(typed.id)!.errors[0];
    assert.true(Failure.is(typedError.error), 'errors[].error is a LIVE Failure');
    assert.equal(typedError.error.code, 'RateLimited', 'a declared throw keeps its code');
    assert.deepEqual(
      typedError.error.data,
      { retryAfter: 30 },
      'and its data — the full Failure API',
    );
    assert.equal(typedError.error.message, 'slow down (30s)', 'and its rendered message');

    const plainError = queue.peek(plain.id)!.errors[0];
    assert.equal(
      plainError.error.code,
      'Unknown',
      'a plain throw (a bug) is coerced to code `Unknown`',
    );
    assert.equal(plainError.error.message, 'kaboom', 'the Unknown renders the original message');
    assert.true(
      String((plainError.error.cause as Error)?.message).includes('kaboom'),
      'with the original error preserved in .cause',
    );

    const badError = queue.peek(bad.id)!.errors[0];
    assert.equal(badError.error.code, 'RateLimited', 'still a Failure with its code');
    assert.true(
      queue.peek(bad.id)!.state === 'discarded',
      'and it persisted (discarded) despite non-serializable data — no crash',
    );
    queue.stop();
  });

  test('errors survive a reload as live Failures — uniform on fresh AND reloaded jobs', async (assert) => {
    const RateLimited = Failure.define('RateLimited', (d: { n: number }) => `rate ${d.n}`);
    const store = memoryStore(); // the SHARED durable store
    const first = Job.queue({
      store,
      backoff: () => 0,
      pollMs: 10,
      workers: {
        doomed: () => {
          throw RateLimited({ n: 7 });
        },
      },
    });
    const job = await first.insert('doomed', {}, { maxAttempts: 1 });
    await first.drain();
    assert.true(
      Failure.is(first.peek(job.id)!.errors[0].error),
      'fresh: the error is a live Failure',
    );
    first.stop();

    // reload on the SAME store — the error came off disk as a wire form and must be revived.
    const second = Job.queue({ store, pollMs: 10 });
    await second.drain(); // awaits `loaded`, which rehydrates
    const reloaded = second.peek(job.id)!;
    assert.equal(reloaded.state, 'discarded', 'the dead-letter job reloaded');
    assert.true(
      Failure.is(reloaded.errors[0].error),
      'reloaded: STILL a live Failure — not a plain object',
    );
    assert.equal(reloaded.errors[0].error.code, 'RateLimited', 'with its code');
    assert.deepEqual(reloaded.errors[0].error.data, { n: 7 }, 'and its data');
    second.stop();
  });

  test('scheduleIn parks a job in `scheduled` until its time, then it runs and is removed', async (assert) => {
    const ran: number[] = [];
    const queue = Job.queue({
      store: memoryStore(),
      workers: { later: () => void ran.push(Date.now()) },
      pollMs: 10,
    });
    const job = await queue.insert('later', {}, { scheduleIn: 80 });
    assert.equal(
      queue.peek(job.id)?.state,
      'scheduled',
      'parked in `scheduled` — not runnable yet',
    );
    await queue.drain(); // drains what is runnable NOW — the scheduled job is not
    assert.deepEqual(ran, [], 'not executed before its time');
    await settle(120);
    await queue.drain();
    assert.equal(ran.length, 1, 'executed once, after its time');
    assert.equal(queue.peek(job.id), undefined, 'and then removed');
    queue.stop();
  });

  test('per-queue concurrency limits hold; priority 0 beats 9', async (assert) => {
    let inFlight = 0;
    let peak = 0;
    const order: string[] = [];
    const queue = Job.queue({
      store: memoryStore(),
      queues: { mailers: 2 },
      workers: {
        mail: async (args) => {
          order.push((args as { tag: string }).tag);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await settle(20);
          inFlight -= 1;
        },
      },
      pollMs: 5,
    });
    queue.pauseQueue('mailers'); // stage everything first, then release — deterministic ordering
    await queue.insert('mail', { tag: 'low' }, { queue: 'mailers', priority: 9 });
    await queue.insert('mail', { tag: 'urgent' }, { queue: 'mailers', priority: 0 });
    for (let index = 0; index < 3; index += 1)
      await queue.insert('mail', { tag: `bulk${index}` }, { queue: 'mailers', priority: 5 });
    queue.resumeQueue('mailers');
    await queue.drain();
    assert.equal(peak, 2, 'never more than the queue limit in flight');
    assert.equal(order[0], 'urgent', 'priority 0 ran first');
    assert.equal(order.at(-1), 'low', 'priority 9 ran last');
    queue.stop();
  });

  test('unique inserts dedupe; cancelJob removes a pending job', async (assert) => {
    const ran: unknown[] = [];
    const queue = Job.queue({
      store: memoryStore(),
      workers: { once: (args) => void ran.push(args) },
      pollMs: 10,
    });
    queue.pauseQueue('default');
    const jobA = await queue.insert('once', { key: 'x' }, { unique: true });
    const jobB = await queue.insert('once', { key: 'x' }, { unique: true });
    assert.equal(jobB.id, jobA.id, 'the duplicate returned the existing job — no second row');

    const jobToCancel = await queue.insert('once', { key: 'y' });
    await queue.cancelJob(jobToCancel.id);
    assert.equal(queue.peek(jobToCancel.id), undefined, 'a cancelled pending job is removed');
    queue.resumeQueue('default');
    await queue.drain();
    assert.deepEqual(ran, [{ key: 'x' }], 'deduped ran once; cancelled never ran');
    queue.stop();
  });

  test('crash rescue: the stager reclaims a job orphaned `executing` by a dead node', async (assert) => {
    // ONE logical node, two SEQUENTIAL lives — not two concurrent nodes (that's the multi-node test
    // below). A real crash can't be spawned in-process, so `first.stop()` + a fresh `second` on the
    // SAME durable store stands in for "the process died and restarted". Recovery is the stager's job
    // (Oban's Lifeline): time-gated on `attemptedAt`, so it reclaims a genuinely-stale orphan without
    // ever resetting a peer's LIVE job. The injectable clock makes "past the reclaim window" exact.
    const store = memoryStore(); // the SHARED durable store (Postgres in production)
    const clock = { t: Date.UTC(2020, 0, 1, 0, 0, 0) };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = Job.queue({
      store,
      workers: { task: () => gate }, // never finishes — the "process" dies mid-attempt
      now: () => clock.t,
      pollMs: 10,
    });
    const job = await first.insert('task', { payload: 7 });
    const deadline = Date.now() + 2000;
    while (first.peek(job.id)?.state !== 'executing' && Date.now() < deadline) await settle(10);
    assert.equal(
      first.peek(job.id)?.state,
      'executing',
      'the attempt is in flight — the job is `executing`',
    );
    first.stop(); // the process crashes — the job is stranded `executing` in the store
    // do NOT release yet: releasing would let first's in-flight attempt remove the job from the store

    clock.t += 60_000; // a minute later — well past the 30s reclaim window
    const done: unknown[] = [];
    const second = Job.queue({
      store,
      workers: { task: (args) => void done.push(args) },
      reclaimAfterMs: 30_000, // the stager (Lifeline): reclaim jobs executing > 30s
      now: () => clock.t,
      pollMs: 10,
    });
    await second.drain();
    assert.deepEqual(done, [{ payload: 7 }], 'the stager rescued the orphan and it completed');
    assert.equal(second.peek(job.id), undefined, 'the reclaimed job completed and was removed');
    second.stop();
    release(); // let first's dangling attempt settle
  });

  test('insert returns an eager Task — a real Promise, and .result() gives the bare union', async (assert) => {
    const queue = Job.queue({ store: memoryStore(), workers: { 'reports.export': () => 'ok' } });
    queue.pauseQueue('default'); // keep jobs enqueued (instant workers would run+remove them)

    const handle = queue.insert('reports.export', { n: 1 });
    assert.true(
      handle instanceof Promise,
      'a Task IS a Promise — a drop-in for the old return type (so `await`/`.then` just work)',
    );
    assert.equal(
      typeof handle.result,
      'function',
      'and it is genuinely a Task, not a bare Promise — `.result()`/`.perform()` are present',
    );
    const jobA = await handle;
    assert.equal(
      queue.peek(jobA.id)?.state,
      'available',
      'the insert was eager — the job is already enqueued and `available`',
    );

    // the uniformity win: .result() settles to the bare Result union (Job | Failure) — no try/catch;
    // Failure.is() is the discriminator. (insert only fails on a store write error; here it succeeds.)
    const jobB = await queue.insert('reports.export', { n: 2 }).result();
    assert.false(Failure.is(jobB), 'a successful insert resolves to the Job, not a Failure');
    assert.deepEqual(
      (jobB as { args: unknown }).args,
      { n: 2 },
      'the enqueued Job came back through result() — carrying its data',
    );

    queue.resumeQueue('default');
    await queue.drain();
    queue.stop();
  });

  test('multi-node: two drainers on ONE store split the work, never double-run (atomic claim)', async (assert) => {
    const store = memoryStore(); // one shared store; two independent queue instances, both active
    const ranBy: Record<string, string> = {}; // jobId -> node that ran it, or 'DUP' if two did
    const make = (node: string) =>
      Job.queue({
        store,
        pollMs: 5,
        queues: { default: 3 }, // each runs at most 3 at once — neither can grab all 12
        workers: {
          work: async (args) => {
            const jobId = (args as { id: string }).id;
            ranBy[jobId] = ranBy[jobId] ? 'DUP' : node;
            await settle(25);
          },
        },
      });
    const queueA = make('A');
    const queueB = make('B');
    for (let index = 0; index < 12; index += 1) await queueA.insert('work', { id: `j${index}` });

    await Promise.all([queueA.drain(), queueB.drain()]); // both drain concurrently — no leader election
    const outcomes = Object.values(ranBy);
    assert.equal(Object.keys(ranBy).length, 12, 'every job ran exactly once');
    assert.equal(
      outcomes.filter((tag) => tag === 'DUP').length,
      0,
      'no job ran twice — the claim is atomic',
    );
    assert.true(
      outcomes.includes('A') && outcomes.includes('B'),
      'both nodes drained a share — SKIP-LOCKED-style, no singleton',
    );
    queueA.stop();
    queueB.stop();
  });

  test('a failed attempt with tries left parks in `retryable`, its next run scheduled by backoff', async (assert) => {
    let calls = 0;
    const clock = { t: Date.UTC(2021, 0, 1, 0, 0, 0) };
    const queue = Job.queue({
      store: memoryStore(),
      workers: {
        flaky: () => {
          calls += 1;
          throw new Error('boom');
        },
      },
      backoff: (attempt) => 60_000 * attempt, // a real, long backoff — the retry is not due yet
      now: () => clock.t,
      pollMs: 10,
    });
    const job = await queue.insert('flaky', {}, { maxAttempts: 3 });
    await queue.drain(); // one attempt runs and fails → retryable, parked in the future
    assert.equal(calls, 1, 'exactly one attempt so far — the retry is not due');
    const retryable = queue.peek(job.id)!;
    assert.equal(
      retryable.state,
      'retryable',
      'a failed attempt with tries left parks in `retryable`',
    );
    assert.equal(retryable.attempt, 1, 'one attempt used');
    assert.true(
      retryable.scheduledAt > clock.t,
      'its next run is scheduled in the future (backoff)',
    );
    assert.true(
      String((retryable.errors[0].error.cause as Error)?.message).includes('boom'),
      'the failure is recorded on the job',
    );
    queue.stop();
  });

  test('cancelJob interrupts a cooperative executing job — it stops, is removed, and is NOT retried', async (assert) => {
    let started = false;
    const queue = Job.queue({
      store: memoryStore(),
      workers: {
        loop: async (_args, _job, signal) => {
          started = true;
          for (;;) {
            if (signal.aborted) throw new Error('aborted'); // cooperative: bail when cancelled
            await settle(10);
          }
        },
      },
      backoff: () => 0, // if it were (wrongly) retried, it would re-run immediately
      pollMs: 10,
    });
    const job = await queue.insert('loop', {}, { maxAttempts: 3 });
    const deadline = Date.now() + 2000;
    while (!started && Date.now() < deadline) await settle(10);
    assert.true(started, 'the worker started');

    await queue.cancelJob(job.id); // aborts the signal → the worker bails out
    await settle(50);
    assert.equal(
      queue.peek(job.id),
      undefined,
      'the cancelled job ended terminal (removed) — not retried despite tries left',
    );
    queue.stop();
  });

  test('cancelJob on an executing job aborts its signal — a worker that ignores it still finishes', async (assert) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const done: unknown[] = [];
    const queue = Job.queue({
      store: memoryStore(),
      workers: {
        stubborn: async (args) => {
          await gate; // never checks the signal — the cooperative-cancel fallback
          done.push(args);
        },
      },
      pollMs: 10,
    });
    const job = await queue.insert('stubborn', { n: 1 });
    const deadline = Date.now() + 2000;
    while (queue.peek(job.id)?.state !== 'executing' && Date.now() < deadline) await settle(10);
    assert.equal(queue.peek(job.id)?.state, 'executing', 'the attempt is in flight');

    await queue.cancelJob(job.id); // aborts the signal; this worker doesn't look at it
    assert.equal(
      queue.peek(job.id)?.state,
      'executing',
      'cancel did not force-stop the ignoring worker',
    );

    release();
    await settle(50);
    assert.deepEqual(done, [{ n: 1 }], 'the worker ignored the abort and finished its attempt');
    assert.equal(queue.peek(job.id), undefined, 'and was removed on completion');
    queue.stop();
  });

  test('peekAll() returns a filtered, copy-safe snapshot of jobs — for admin/observability', async (assert) => {
    const queue = Job.queue({
      store: memoryStore(),
      queues: { emails: 5, reports: 5 },
      workers: { send: () => {}, build: () => {} },
      pollMs: 10,
    });
    queue.pauseQueue('emails');
    queue.pauseQueue('reports');
    await queue.insert('send', { to: 'a' }, { queue: 'emails' });
    await queue.insert('send', { to: 'b' }, { queue: 'emails' });
    await queue.insert('build', { id: 1 }, { queue: 'reports' });

    assert.equal(queue.peekAll().length, 3, 'all pending jobs');
    assert.equal(queue.peekAll({ queue: 'emails' }).length, 2, 'filtered by queue');
    assert.equal(queue.peekAll({ worker: 'build' }).length, 1, 'filtered by worker');
    assert.equal(
      queue.peekAll({ state: 'available' }).length,
      3,
      'filtered by state — all available while paused',
    );
    assert.equal(queue.peekAll({ state: 'executing' }).length, 0, 'none executing while paused');

    const snapshot = queue.peekAll({ queue: 'emails' });
    snapshot[0].state = 'discarded'; // mutate the copy
    assert.equal(
      queue.peekAll({ state: 'discarded' }).length,
      0,
      'the snapshot is a copy — the queue is untouched',
    );
    queue.stop();
  });

  test('scheduledAt (absolute epoch) parks in `scheduled` until its time, like scheduleIn', async (assert) => {
    const clock = { t: Date.UTC(2021, 0, 1, 0, 0, 0) };
    const ran: number[] = [];
    const queue = Job.queue({
      store: memoryStore(),
      workers: { later: () => void ran.push(1) },
      now: () => clock.t,
      pollMs: 10,
    });
    const job = await queue.insert('later', {}, { scheduledAt: clock.t + 50_000 });
    assert.equal(
      queue.peek(job.id)?.state,
      'scheduled',
      'parked in `scheduled` until its absolute time',
    );
    await queue.drain();
    assert.deepEqual(ran, [], 'not before its time');
    clock.t += 60_000; // now past the scheduledAt instant
    await queue.drain();
    assert.equal(ran.length, 1, 'runs once its time arrives');
    queue.stop();
  });

  test('prefix isolates two queues sharing one store — neither sees the other’s jobs', async (assert) => {
    const store = memoryStore();
    const ranA: unknown[] = [];
    const ranB: unknown[] = [];
    const queueA = Job.queue({
      store,
      prefix: 'appA',
      workers: { work: (args) => void ranA.push(args) },
      pollMs: 10,
    });
    const queueB = Job.queue({
      store,
      prefix: 'appB',
      workers: { work: (args) => void ranB.push(args) },
      pollMs: 10,
    });
    await queueA.insert('work', { from: 'A' });
    await queueB.insert('work', { from: 'B' });
    await Promise.all([queueA.drain(), queueB.drain()]);
    assert.deepEqual(ranA, [{ from: 'A' }], 'queue A ran only its own prefixed job');
    assert.deepEqual(ranB, [{ from: 'B' }], 'queue B ran only its own prefixed job');
    queueA.stop();
    queueB.stop();
  });

  test('onExit fires on a scheduler-level failure when supervised — for wholesale restart', async (assert) => {
    // A store whose claim always throws → the SCHEDULER (not a worker) fails every tick.
    const store = { ...memoryStore(), claim: () => Promise.reject(new Error('store down')) };
    const queue = Job.queue({ store, workers: { work: () => {} }, pollMs: 10 });
    const crashes: unknown[] = [];
    queue.onExit((reason) => crashes.push(reason)); // registering opts into fail-fast

    await queue.insert('work'); // save works; the tick's claim throws → scheduler failure
    await settle(50);
    assert.equal(crashes.length, 1, 'the scheduler failure was reported once via onExit');
    assert.true(String(crashes[0]).includes('store down'), 'carrying the underlying error');
    queue.stop();
  });

  test('dead-letter routing: a discarded job’s errors.code discriminates a declared Failure from a bug', async (assert) => {
    const RateLimited = Failure.define('RateLimited', () => 'slow down');
    const queue = Job.queue({
      store: memoryStore(),
      backoff: () => 0,
      pollMs: 10,
      workers: {
        declared: () => {
          throw RateLimited({}); // a DECLARED failure — expected, carries a code
        },
        buggy: () => {
          throw new TypeError('undefined is not a function'); // a BUG — unexpected, no code
        },
      },
    });
    await queue.insert('declared', {}, { maxAttempts: 1 });
    await queue.insert('buggy', {}, { maxAttempts: 1 });
    await queue.drain();

    const discarded = queue.peekAll({ state: 'discarded' });
    assert.equal(discarded.length, 2, 'both failures are in the dead-letter queue');
    const codeOf = (worker: string) =>
      discarded.find((job) => job.worker === worker)!.errors.at(-1)?.error?.code;
    assert.equal(
      codeOf('declared'),
      'RateLimited',
      'a declared Failure carries its code — route/handle it',
    );
    assert.equal(
      codeOf('buggy'),
      'Unknown',
      'a bug is coerced to code `Unknown` — that is your "page on-call" signal',
    );
    queue.stop();
  });

  test('a worker can Job.discard() a job — terminal now, skipping remaining attempts, routable by code', async (assert) => {
    const PaymentDeclined = Failure.define(
      'PaymentDeclined',
      (d: { card: string }) => `declined ${d.card}`,
    );
    const queue = Job.queue({
      store: memoryStore(),
      backoff: () => 0,
      pollMs: 10,
      workers: { charge: () => Job.discard(PaymentDeclined({ card: '***1' })) },
    });
    const job = await queue.insert('charge', {}, { maxAttempts: 5 });
    await queue.drain();
    const dead = queue.peek(job.id)!;
    assert.equal(dead.state, 'discarded', 'discarded immediately — not retried');
    assert.equal(dead.attempt, 1, 'only one attempt — the 5-attempt budget was NOT spent');
    assert.equal(
      dead.errors.at(-1)?.error?.code,
      'PaymentDeclined',
      'the discard reason is routable by code',
    );
    queue.stop();
  });

  test('a worker can Job.snooze() a job — reschedule without burning an attempt', async (assert) => {
    const clock = { t: Date.UTC(2021, 0, 1, 0, 0, 0) };
    let calls = 0;
    const queue = Job.queue({
      store: memoryStore(),
      now: () => clock.t,
      pollMs: 10,
      workers: {
        poll: () => {
          calls += 1;
          return calls === 1 ? Job.snooze(50_000) : undefined; // snooze once, then succeed
        },
      },
    });
    const job = await queue.insert('poll', {}, { maxAttempts: 2 });
    await queue.drain();
    const snoozed = queue.peek(job.id)!;
    assert.equal(snoozed.state, 'scheduled', 'rescheduled by the snooze');
    assert.true(snoozed.scheduledAt > clock.t, 'to the future');
    assert.equal(
      snoozed.maxAttempts,
      3,
      'maxAttempts bumped so the snooze did not consume a retry',
    );

    clock.t += 60_000; // past the snooze window
    await queue.drain();
    assert.equal(calls, 2, 'it ran again after the snooze');
    assert.equal(queue.peek(job.id), undefined, 'and then completed');
    queue.stop();
  });
});
