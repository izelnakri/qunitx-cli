/**
 * `Job.queue` — Elixir's **Oban**: the durable background-job queue every production web service
 * grows ("send this email, retry 3 times, run it at 9am"). Jobs are persisted through the
 * {@link Store} seam BEFORE `insert` resolves (a `memoryStore` in tests, Postgres in production —
 * the same durability contract as persist-before-ack actors), executed by named workers under
 * per-queue concurrency limits, retried on failure with backoff until `maxAttempts` (then kept as
 * `discarded`, errors attached), and **rescued after a crash** by the stager (Oban's Lifeline, on by
 * default): a job left `executing` past the reclaim window by a dead node runs again.
 *
 * Oban's surface, JS-shaped: `insert(worker, args, { queue, maxAttempts, scheduleIn, priority,
 * unique })`, `cancelJob`, `pauseQueue`/`resumeQueue`, and `drain()` (Oban's `drain_queue` — the
 * test helper that runs everything runnable to completion). Telemetry mirrors Oban's:
 * `['jobs','execute','start'|'stop'|'exception']` with worker/queue/attempt metadata.
 *
 * **Distributed like Oban, by default.** Run the same queue on every node against one shared
 * {@link Store}: each node polls and drains, and the store's atomic {@link Store.claim} (Oban's
 * `SELECT … FOR UPDATE SKIP LOCKED`) hands each job to exactly one node — no leader election, no
 * `pollStore` flag, no double execution. A `memoryStore` claims in one event-loop turn (in-process
 * clustering); a Postgres store would use row locks. Without a `claim` a queue simply drains its
 * own inserts (single process). Cron is the exception — every node would fire it, so pass a
 * `leader` (Oban's `Peer`, see {@link leader}) and exactly one node fires each schedule.
 *
 * **Recurring cron** (Oban's Cron plugin): pass `cron` — each expression enqueues its job every
 * matching UTC minute; a schedule fires at most once per matching minute per instance.
 *
 * ```ts
 * import { memoryStore } from '../node/index.ts';
 * const sent: string[] = [];
 * const jobs = Job.queue({
 *   store: memoryStore(),
 *   workers: { 'email.welcome': (args) => void sent.push((args as { to: string }).to) },
 * });
 * await jobs.insert('email.welcome', { to: 'ada@example.com' });
 * await jobs.drain();
 * sent; // ['ada@example.com']
 * jobs.stop();
 * ```
 */
import {
  from as toFailure,
  fromJSON as reviveFailure,
  type Any as AnyFailure,
  type SerializedFailure,
} from '../result/failure.ts';
import { Task } from '../task/task.ts';
import { execute as emit } from '../telemetry/telemetry.ts';
import { cronMatch } from './cron.ts';
import type { Leader } from './leader.ts';
import type { Store } from '../node/store.ts';

// Tag for the control-flow values a worker RETURNS to steer its own fate (Oban's discard/snooze) —
// distinct from a THROW, which is always a retryable failure.
const SIGNAL = Symbol.for('qunitx.jobs.signal');
type JobControl = { kind: 'discard'; reason?: unknown } | { kind: 'snooze'; ms: number };

/** A recurring schedule entry — a cron expression mapped to the job it enqueues. */
export interface CronEntry {
  /** The worker to run on each fire. */
  worker: string;
  /** Arguments for each enqueued run. */
  args?: unknown;
  /** The queue to enqueue on (default 'default'). */
  queue?: string;
  /** Priority of the enqueued job (default 0). */
  priority?: number;
}

/** A job's lifecycle state — Oban's states, minus its `cancelled` (a cancelled job is removed). */
export type JobState = 'available' | 'scheduled' | 'executing' | 'retryable' | 'discarded';

/** One entry in a job's failure log. `error` is a live {@link Failure} — a declared throw keeps its
 *  `code`/`data`; a plain throw (a bug) is coerced to code `'Unknown'` with the original in `.cause`.
 *  Uniform on fresh AND reloaded jobs: the queue serializes it (a Failure's `toJSON` is auto-invoked
 *  by the Store's `JSON.stringify`) and revives it with `Failure.fromJSON` on load — so a reader
 *  always gets a real Failure (`isFailure(entry.error)`, `.code`, `.data`, `.match`), never the wire
 *  form. Storing a live instance is impossible (its `Symbol.for` brand doesn't survive JSON); the
 *  serialize/revive round-trip is how you get one back anyway. */
export interface JobError {
  /** Which attempt failed (1-based). */
  attempt: number;
  /** When it failed (epoch ms). */
  at: number;
  /** The failure — always a live {@link AnyFailure} (revived on reload); route on its `code`. */
  error: AnyFailure;
}

/**
 * One durable job.
 *
 * ```ts
 * import { memoryStore } from '../node/index.ts';
 * const jobs = Job.queue({ store: memoryStore(), workers: {} });
 * typeof jobs.insert; // 'function'
 * jobs.stop();
 * ```
 */
export interface Job {
  /** Unique id (assigned at insert). */
  id: string;
  /** The worker name that executes it. */
  worker: string;
  /** The worker's arguments — structured-clone-safe. */
  args: unknown;
  /** The queue it runs on (its concurrency lane). */
  queue: string;
  /** Where it is in the lifecycle. */
  state: JobState;
  /** Attempts made so far. */
  attempt: number;
  /** Attempts allowed before it is discarded. */
  maxAttempts: number;
  /** Lower runs first when contending (Oban's priority, 0 = most urgent). */
  priority: number;
  /** Not runnable before this time (epoch ms) — scheduling and retry backoff both live here. */
  scheduledAt: number;
  /** When the current attempt started executing (epoch ms) — the stager reclaims jobs stuck
   *  `executing` past a timeout (a node died mid-run). Set by the claim, absent otherwise. */
  attemptedAt?: number;
  /** Free-form metadata (Oban's `meta`), structured-clone-safe. Cron-inserted jobs carry
   *  `{ cron: <expression> }`; it also participates in the `unique` identity (see insert). */
  meta?: Record<string, unknown>;
  /** One entry per failed attempt — see {@link JobError}. */
  errors: JobError[];
}

/** A worker: receives the job's args (and the job record); throwing marks the attempt failed. */
export type Worker = (args: unknown, job: Job, signal: AbortSignal) => unknown | Promise<unknown>;

/** A running job queue — see {@link Job.queue}. */
export interface JobQueue {
  /**
   * Durably enqueue a job — persisted BEFORE the Task settles. Options mirror Oban's:
   * `queue` (default 'default'), `maxAttempts` (default 3), `scheduleIn` ms / `scheduledAt`
   * epoch-ms, `priority` (0 = most urgent), `meta` (free-form tags), and `unique` (skip if a job
   * with the same worker+args+meta is already pending — returns the existing one). The Task is **eager** (the write is
   * in flight before you await, exactly as a Promise) and settles with the job record.
   */
  insert(
    worker: string,
    args?: unknown,
    options?: {
      queue?: string;
      maxAttempts?: number;
      scheduleIn?: number;
      scheduledAt?: number;
      priority?: number;
      unique?: boolean;
      meta?: Record<string, unknown>;
    },
  ): Task<Job, AnyFailure>;
  /** Peek at the current record for a job id, or undefined (completed jobs are removed). Read-only —
   *  the multi-job twin is {@link JobQueue.peekAll}. (Oban has no single-job getter; this is ours.) */
  peek(id: string): Job | undefined;
  /** Peek at a read-only snapshot of this instance's jobs, optionally filtered by queue/state/worker —
   *  for admin and observability. A pure in-memory read (NO store/SQL query, even on postgresStore):
   *  Oban queries its table; this reads only THIS instance's view. `peek`'s multi-job twin. */
  peekAll(filter?: { queue?: string; state?: JobState; worker?: string }): Job[];
  /** Cancel a job — Oban's `cancel_job`. A PENDING job is removed; an EXECUTING one has its
   *  {@link Worker}'s `AbortSignal` aborted (cooperative — a worker that ignores it finishes), and
   *  ends terminal (removed), not retried. */
  cancelJob(id: string): Task<void, AnyFailure>;
  /** Stop starting jobs on `queue` (executing ones finish) — Oban's `pause_queue`. */
  pauseQueue(queue: string): void;
  /** Resume a paused queue. */
  resumeQueue(queue: string): void;
  /** Run everything currently runnable to completion — Oban's `drain_queue`, the test helper. */
  drain(): Task<void, AnyFailure>;
  /** Stop the scheduler (executing attempts finish; nothing new starts). */
  stop(): void;
  /** Report a CATASTROPHIC scheduler failure (not a job failure — those retry) so a {@link
   *  supervisor} can restart the queue wholesale; the fresh instance re-reads the Store. Registering
   *  a handler opts the queue into fail-fast: an unsupervised queue keeps swallowing tick errors. */
  onExit(handler: (reason?: unknown) => void): void;
}

/**
 * Build a {@link JobQueue}. `workers` maps worker names to functions; `queues` sets per-queue
 * concurrency (default `{ default: 10 }`); `backoff` maps a failed attempt count to a retry
 * delay in ms (default Oban's `attempt⁴ + 15s` shape); `pollMs` is the scheduler tick.
 *
 * ```ts
 * import { memoryStore } from '../node/index.ts';
 * const jobs = Job.queue({ store: memoryStore(), workers: {} });
 * typeof jobs.insert; // 'function'
 * jobs.stop();
 * ```
 */
function jobQueue(options: {
  store: Store;
  workers: Record<string, Worker>;
  queues?: Record<string, number>;
  backoff?: (attempt: number) => number;
  pollMs?: number;
  /** Namespaces this queue's store keys (Oban's `prefix` — its Postgres schema). Two queues on one
   *  store with different prefixes are isolated. Default `'jobs'`. */
  prefix?: string;
  /** Recurring jobs — Oban's Cron plugin: a cron expression (UTC) enqueues its job each time it
   *  matches. A schedule fires at most once per matching minute per instance; across a cluster,
   *  pass `leader` so only ONE node fires each schedule (else every node would). Give an expression a
   *  LIST of entries to run several workers on the same schedule (Oban allows duplicate crontab
   *  rows; a record key can't repeat, so the array value is the JS-shaped equivalent). */
  cron?: Record<string, CronEntry | CronEntry[]>;
  /** Cluster leadership for cron AND the stager — Oban's `Peer`. When set, this instance evaluates
   *  cron / runs the stager only while it holds the lease, so each fires once cluster-wide. See
   *  {@link leader}. */
  leader?: Leader;
  /** The stager (Oban's Lifeline): reclaim jobs stuck `executing` this many ms — a node died mid-run
   *  — back to `available` so a survivor re-runs them; the same time gate also drives boot recovery.
   *  Defaults to 60 min (Oban's `rescue_after`); MUST exceed the longest job runtime or a live long
   *  job gets reclaimed. Needs a `Store` with `rescue` (memoryStore / raftStore / Postgres). Pass
   *  `Infinity` to disable — recovery is purely time-gated, never an unconditional boot reset (which
   *  would double-run a peer's live job on a rolling deploy). */
  reclaimAfterMs?: number;
  /** Injectable wall-clock (epoch ms) — for deterministic scheduling/cron/backoff tests. */
  now?: () => number;
}): JobQueue {
  const queues = options.queues ?? { default: 10 };
  const backoff = options.backoff ?? ((attempt) => 1000 * attempt ** 4 + 15_000);
  const pollMs = options.pollMs ?? 50;
  const reclaimAfterMs = options.reclaimAfterMs ?? 3_600_000; // Oban's Lifeline default (60 min)
  const now = options.now ?? (() => Date.now());
  const prefix = options.prefix ?? 'jobs';
  const jobKey = (id: string) => `${prefix}:${id}`;
  const INDEX = `${prefix}:index`;

  // The in-memory truth; the store mirrors it durably (job first, then index — an orphaned job
  // key from a crash between the two writes is simply ignored on load).
  const jobs = new Map<string, Job>();
  const executing = new Map<string, number>(); // queue -> running count
  const running = new Map<string, AbortController>(); // id -> abort handle for the live attempt
  const cancelled = new Set<string>(); // ids cancelled mid-attempt — end terminal, don't retry
  const paused = new Set<string>();
  const seenQueues = new Set<string>(['default']); // queues to poll (configured + inserted-into)
  const uniqueIndex = new Map<string, Set<string>>(); // signature -> ids: O(1) `unique` dedup
  const queueJobs = new Map<string, Set<string>>(); // queue -> its job ids: scoped claim + seenQueues evict
  const signatureOf = (worker: string, args: unknown, meta?: Record<string, unknown>): string =>
    JSON.stringify([worker, args, meta ?? null]);
  const indexAdd = (job: Job): void => {
    const sig = signatureOf(job.worker, job.args, job.meta);
    let ids = uniqueIndex.get(sig);
    if (!ids) uniqueIndex.set(sig, (ids = new Set()));
    ids.add(job.id);
    let q = queueJobs.get(job.queue);
    if (!q) queueJobs.set(job.queue, (q = new Set()));
    q.add(job.id);
  };
  const indexRemove = (job: Job): void => {
    const sig = signatureOf(job.worker, job.args, job.meta);
    const ids = uniqueIndex.get(sig);
    if (ids) {
      ids.delete(job.id);
      if (ids.size === 0) uniqueIndex.delete(sig);
    }
    const q = queueJobs.get(job.queue);
    if (q) {
      q.delete(job.id);
      if (q.size === 0) {
        queueJobs.delete(job.queue);
        seenQueues.delete(job.queue); // last job in an ad-hoc queue gone — stop tracking its name
      }
    }
  };
  let alive = true;

  const persistJob = (job: Job): Promise<void> => options.store.save(jobKey(job.id), job);
  const canList = typeof options.store.keys === 'function';
  // When the store can list keys by prefix, the job keys themselves ARE the index — so skip the
  // rewrite-the-whole-id-array-on-every-insert/complete blob (was O(total jobs) per op).
  const persistIndex = (): Promise<void> =>
    canList ? Promise.resolve() : options.store.save(INDEX, [...jobs.keys()]);
  const removeJob = async (id: string): Promise<void> => {
    const job = jobs.get(id);
    jobs.delete(id);
    if (job) indexRemove(job);
    await persistIndex(); // index first — a crash leaves an ignorable orphan key, never a ghost id
    await options.store.clear(jobKey(id));
  };

  // Crash recovery is the stager's job (Oban's Lifeline, on by default): rescue on boot with the SAME
  // time+leader gate the interval uses — a job left `executing` past the reclaim window was orphaned
  // by a dead node. Never an unconditional reset: with concurrent nodes that would reset a peer's LIVE
  // job (a rolling deploy → double run). `reclaimAfterMs: Infinity` disables it. Rescue first, then
  // load, so the in-memory view reflects the reset states.
  const loaded: Promise<void> = (async () => {
    if (
      Number.isFinite(reclaimAfterMs) &&
      options.store.rescue &&
      !(options.leader && !options.leader.isLeader())
    ) {
      await options.store.rescue(prefix, now() - reclaimAfterMs);
    }
    const keys = canList
      ? await options.store.keys!(`${prefix}:`)
      : (((await options.store.load(INDEX)) as string[] | undefined) ?? []).map(jobKey);
    for (const key of keys) {
      const job = (await options.store.load(key)) as Job | undefined;
      // A prefix scan also surfaces the INDEX blob / lease keys — skip anything that isn't a job.
      if (!job || typeof job !== 'object' || !('id' in job) || !('worker' in job)) continue;
      // Errors round-tripped through the Store as wire forms — revive each to a live Failure so a
      // reloaded job's errors are Failures too (the whole point: uniform on fresh AND reloaded).
      for (const entry of job.errors)
        entry.error = reviveFailure(entry.error as unknown as SerializedFailure);
      jobs.set(job.id, job);
      indexAdd(job);
    }
  })();

  const runnable = (job: Job, now: number): boolean =>
    (job.state === 'available' || job.state === 'scheduled' || job.state === 'retryable') &&
    job.scheduledAt <= now &&
    !paused.has(job.queue);

  const run = async (job: Job): Promise<void> => {
    // `job` arrives already marked `executing` with `attempt` incremented — the claim did that
    // atomically (that mark is also what a crash-rescue keys on). Here we only run it.
    executing.set(job.queue, (executing.get(job.queue) ?? 0) + 1);
    const controller = new AbortController(); // aborted by cancelJob to interrupt this attempt
    running.set(job.id, controller);
    const meta = { worker: job.worker, queue: job.queue, id: job.id, attempt: job.attempt };
    const started = performance.now();
    emit(['jobs', 'execute', 'start'], {}, meta);
    try {
      const outcome = await options.workers[job.worker]?.(job.args, job, controller.signal);
      emit(['jobs', 'execute', 'stop'], { duration: performance.now() - started }, meta);
      const signal = jobSignal(outcome);
      if (signal?.kind === 'discard') {
        // The worker decided this failure is TERMINAL — dead-letter it now, skipping remaining
        // attempts (Oban's {:discard}). A Failure reason lands in errors, routable by its code.
        job.state = 'discarded';
        if (signal.reason !== undefined)
          job.errors.push(errorRecord(signal.reason, job.attempt, now()));
        await persistJob(job);
      } else if (signal?.kind === 'snooze') {
        // Reschedule (Oban's {:snooze}); bump maxAttempts so the snooze doesn't consume a retry.
        job.maxAttempts += 1;
        job.state = 'scheduled';
        job.scheduledAt = now() + signal.ms;
        await persistJob(job);
      } else {
        await removeJob(job.id); // real success — completed jobs are removed, the queue stays bounded
      }
    } catch (error) {
      emit(['jobs', 'execute', 'exception'], { duration: performance.now() - started }, meta);
      if (cancelled.has(job.id)) {
        await removeJob(job.id); // cancelled mid-attempt → terminal (removed), never retried
      } else {
        job.errors.push(errorRecord(error, job.attempt, now()));
        if (job.attempt >= job.maxAttempts) {
          job.state = 'discarded'; // kept, with its errors — the dead-letter record
        } else {
          job.state = 'retryable';
          job.scheduledAt = now() + backoff(job.attempt);
        }
        await persistJob(job);
      }
    } finally {
      executing.set(job.queue, (executing.get(job.queue) ?? 1) - 1);
      running.delete(job.id);
      cancelled.delete(job.id);
    }
  };

  // Enqueue a job durably — shared by the public insert() and the cron scheduler.
  const doInsert = async (
    worker: string,
    args: unknown,
    opts: {
      queue?: string;
      maxAttempts?: number;
      scheduleIn?: number;
      scheduledAt?: number;
      priority?: number;
      unique?: boolean;
      meta?: Record<string, unknown>;
    },
  ): Promise<Job> => {
    if (opts.unique) {
      // Identity includes `meta`, so two cron schedules that share a worker+args (each tagged with
      // its own `{ cron: expr }`) don't collapse into one — while a single schedule still dedupes.
      const ids = uniqueIndex.get(signatureOf(worker, args, opts.meta));
      if (ids)
        for (const id of ids) {
          const existing = jobs.get(id);
          if (existing) return existing; // a pending twin already exists — dedupe to it
        }
    }
    const job: Job = {
      id: crypto.randomUUID(),
      worker,
      args,
      queue: opts.queue ?? 'default',
      state: opts.scheduleIn || opts.scheduledAt ? 'scheduled' : 'available',
      attempt: 0,
      maxAttempts: opts.maxAttempts ?? 3,
      priority: opts.priority ?? 0,
      scheduledAt: opts.scheduledAt ?? (opts.scheduleIn ? now() + opts.scheduleIn : 0),
      ...(opts.meta ? { meta: opts.meta } : {}),
      errors: [],
    };
    jobs.set(job.id, job);
    seenQueues.add(job.queue); // so the drain loop polls this queue even if it wasn't configured
    indexAdd(job);
    await persistJob(job); // durable BEFORE the caller is told "queued"
    await persistIndex();
    queueMicrotask(() => void tick()); // run it now if a slot is free — the poll is only the backstop
    return job;
  };

  // Cron: at most one enqueue per schedule per matching UTC minute (tracked by minute bucket).
  const cronFired = new Map<string, number>();
  const evaluateCron = (clock: number): void => {
    if (!options.cron) return;
    if (options.leader && !options.leader.isLeader()) return; // cluster-once: only the leader fires

    const minute = Math.floor(clock / 60000);
    const at = new Date(clock);
    for (const [expr, value] of Object.entries(options.cron)) {
      if (cronFired.get(expr) === minute || !cronMatch(expr, at)) continue;
      cronFired.set(expr, minute);
      for (const entry of Array.isArray(value) ? value : [value]) {
        void doInsert(entry.worker, entry.args ?? {}, {
          queue: entry.queue,
          priority: entry.priority,
          unique: true, // dedupe a backed-up schedule (and a second tick in the same minute)
          meta: { cron: expr }, // tag the job with its originating schedule; also scopes `unique`
        });
      }
    }
  };

  const READY: readonly JobState[] = ['available', 'scheduled', 'retryable'];

  // Claim up to `demand` runnable jobs for `queue`, atomically MARKING them executing so no other
  // drainer runs them too. `store.claim` does this across the whole cluster (every node polls, the
  // claim partitions the work — Oban's model, no leader election); without it we claim from this
  // instance's own in-memory jobs (single-writer). Either way the mark is synchronous-before-await,
  // so overlapping ticks never grab the same job.
  const claimJobs = async (queue: string, demand: number): Promise<Job[]> => {
    if (options.store.claim) {
      const claimed = (await options.store.claim(prefix, queue, READY, now(), demand)) as Job[];
      for (const job of claimed) jobs.set(job.id, job); // reflect the store's mark in the local view
      return claimed;
    }
    // Scan only THIS queue's jobs (via the index), not every job in every queue, per tick.
    const due = [...(queueJobs.get(queue) ?? [])]
      .map((id) => jobs.get(id)!)
      .filter((job) => runnable(job, now()))
      .sort((a, b) => a.priority - b.priority || a.scheduledAt - b.scheduledAt)
      .slice(0, demand);
    for (const job of due) {
      job.state = 'executing';
      job.attempt++;
      job.attemptedAt = now(); // stamp for the stager, matching store.claim
      await persistJob(job);
    }
    return due;
  };

  // Queues to poll: the configured ones plus any an insert has used (an ad-hoc queue name).
  const drainQueues = (): string[] => [...new Set([...Object.keys(queues), ...seenQueues])];

  // The scheduler: fire due cron schedules, then for each queue claim its free slots and run them.
  // Returns how many jobs it started (drain uses it to know when the store is quiescent).
  const runTick = async (): Promise<number> => {
    if (!alive) return 0;
    evaluateCron(now());
    let started = 0;
    for (const queue of drainQueues()) {
      if (paused.has(queue)) continue;
      const limit = queues[queue] ?? queues.default ?? 10;
      const demand = limit - (executing.get(queue) ?? 0);
      if (demand <= 0) continue;
      for (const job of await claimJobs(queue, demand)) {
        void run(job); // run() bumps the executing count synchronously — the next queue sees it
        started += 1;
      }
    }
    return started;
  };
  // Serialise ticks. Overlapping polls would each read a stale `executing` across the `await claim`
  // and over-claim past the concurrency limit; the atomic claim stops two ticks taking the SAME
  // job, not the count. Chaining runs one tick at a time; a failed tick can't break the ones after.
  let tail: Promise<unknown> = Promise.resolve();
  let crashHandler: ((reason?: unknown) => void) | undefined; // set by onExit — see below
  const tick = (): Promise<number> => {
    const result = tail.then(runTick);
    tail = result.catch((error) => {
      // A throw here is SCHEDULER-level (worker errors are caught in run()) — a store outage or a
      // bug. Supervised (a handler is registered): fail fast so the supervisor restarts us fresh.
      // Unsupervised: swallow and keep ticking, the queue's own resilience.
      if (crashHandler && alive) {
        alive = false;
        clearInterval(timer);
        if (stagerTimer) clearInterval(stagerTimer);
        crashHandler(error);
      }
    });
    return result;
  };
  const timer = setInterval(() => void tick(), pollMs);
  (timer as { unref?: () => void }).unref?.();
  // rescued + peer work starts once reload finishes; the trailing catch keeps a boot-time scheduler
  // failure from surfacing as an unhandled rejection (it's already reported through tick's onExit path).
  void loaded.then(() => tick()).catch(() => {});

  // The stager (Oban's rescuer): reclaim jobs a dead node left stuck `executing` past the timeout,
  // back to `available` so a survivor re-runs them. Leader-gated (once per cluster) when a leader is
  // set; a reclaimed batch triggers a tick to pick the jobs up.
  let stagerTimer: ReturnType<typeof setInterval> | undefined;
  if (Number.isFinite(reclaimAfterMs) && options.store.rescue) {
    const rescueStore = options.store.rescue.bind(options.store);
    const rescuePass = async (): Promise<void> => {
      if (!alive) return;
      if (options.leader && !options.leader.isLeader()) return; // one node rescues
      if ((await rescueStore(prefix, now() - reclaimAfterMs)) > 0) void tick();
    };
    stagerTimer = setInterval(
      () => void rescuePass().catch(() => {}),
      Math.max(pollMs, Math.floor(reclaimAfterMs / 3)),
    );
    (stagerTimer as { unref?: () => void }).unref?.();
  }

  return {
    insert(worker, args = {}, opts = {}) {
      return Task(async () => {
        await loaded;
        return doInsert(worker, args, opts);
      }).perform();
    },
    peek: (id) => jobs.get(id),
    peekAll: (filter = {}) =>
      // One pass: filter-and-copy folded together. Shallow copies so a caller can't corrupt state.
      [...jobs.values()].reduce<Job[]>((matches, job) => {
        if (
          (filter.queue === undefined || job.queue === filter.queue) &&
          (filter.state === undefined || job.state === filter.state) &&
          (filter.worker === undefined || job.worker === filter.worker)
        )
          matches.push({ ...job });
        return matches;
      }, []),
    cancelJob(id) {
      return Task(async () => {
        const controller = running.get(id);
        if (controller) {
          cancelled.add(id); // the attempt ends terminal (removed), not retried
          controller.abort();
          return;
        }
        if (jobs.get(id)) await removeJob(id); // a pending job is removed outright
      }).perform();
    },
    pauseQueue: (queue) => void paused.add(queue),
    resumeQueue(queue) {
      paused.delete(queue);
      void tick();
    },
    drain() {
      return Task(async () => {
        await loaded;
        for (;;) {
          // A tick claims (from the store) and starts everything runnable now; quiescent = nothing
          // started AND nothing still executing. Scheduled-future jobs aren't claimed, so — as
          // before — drain returns without waiting for them.
          const started = await tick();
          const busy = [...executing.values()].some((count) => count > 0);
          if (started === 0 && !busy) return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }).perform();
    },
    stop() {
      alive = false;
      clearInterval(timer);
      if (stagerTimer) clearInterval(stagerTimer);
    },
    onExit(handler) {
      crashHandler = handler;
    },
  };
}

// A failure-log entry: coerce ANY throw to a live Failure (a bug becomes code 'Unknown', the
// original preserved in `.cause`). It serializes on save (toJSON, auto-invoked by the Store's
// JSON.stringify) and is revived to a live Failure on load — see `loaded`.
function errorRecord(error: unknown, attempt: number, at: number): JobError {
  return { attempt, at, error: toFailure(error) };
}

/**
 * Return this from a {@link Worker} to DISCARD the job now — dead-letter it terminally, skipping any
 * remaining `maxAttempts` (Oban's `{:discard, reason}`). A `Failure` reason is recorded in the job's
 * `errors` (routable by its `code`); a THROW, by contrast, always retries.
 */
function discard(reason?: unknown): unknown {
  return { [SIGNAL]: { kind: 'discard', reason } satisfies JobControl };
}

/**
 * Return this from a {@link Worker} to RESCHEDULE the job `ms` in the future (Oban's `{:snooze}`)
 * without consuming a retry — `maxAttempts` is bumped so the snooze is free.
 */
function snooze(ms: number): unknown {
  return { [SIGNAL]: { kind: 'snooze', ms } satisfies JobControl };
}

/**
 * The Jobs namespace — Elixir's Oban, JS-shaped. `Job.queue(...)` builds a durable {@link JobQueue};
 * `Job.discard(reason)` / `Job.snooze(ms)` are the values a {@link Worker} returns to dead-letter or
 * reschedule itself. (`Job` is also the record type — the value and the type share the name.)
 */
export const Job = { queue: jobQueue, discard, snooze };

// The control value a worker returned, or undefined for an ordinary success.
function jobSignal(value: unknown): JobControl | undefined {
  return value !== null && typeof value === 'object' && SIGNAL in value
    ? ((value as Record<symbol, unknown>)[SIGNAL] as JobControl)
    : undefined;
}
