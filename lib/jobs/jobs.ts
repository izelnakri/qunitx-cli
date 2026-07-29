/**
 * `jobQueue` — Elixir's **Oban**: the durable background-job queue every production web service
 * grows ("send this email, retry 3 times, run it at 9am"). Jobs are persisted through the
 * {@link Store} seam BEFORE `insert` resolves (a `memoryStore` in tests, Postgres in production —
 * the same durability contract as persist-before-ack actors), executed by named workers under
 * per-queue concurrency limits, retried on failure with backoff until `maxAttempts` (then kept as
 * `discarded`, errors attached), and **rescued after a crash**: a job found `executing` on load
 * was orphaned by a dead process and runs again.
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
 * own inserts (single process). Cron is the exception — every node would fire it, so a schedule
 * must run on ONE node; that leader election is a follow-up (Oban's `Peer`), not here yet.
 *
 * **Recurring cron** (Oban's Cron plugin): pass `cron` — each expression enqueues its job every
 * matching UTC minute; a schedule fires at most once per matching minute per instance.
 *
 * ```ts
 * import { memoryStore } from '../node/index.ts';
 * const sent: string[] = [];
 * const jobs = jobQueue({
 *   store: memoryStore(),
 *   workers: { 'email.welcome': (args) => void sent.push((args as { to: string }).to) },
 * });
 * await jobs.insert('email.welcome', { to: 'ada@example.com' });
 * await jobs.drain();
 * sent; // ['ada@example.com']
 * jobs.stop();
 * ```
 */
import { isFailure, type Any as AnyFailure } from '../result/failure.ts';
import { Task } from '../task/task.ts';
import { execute as emit } from '../telemetry/telemetry.ts';
import { cronMatch } from './cron.ts';
import type { Leader } from './leader.ts';
import type { Store } from '../node/upgradable.ts';

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

/** One durable job. */
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
  /** One entry per failed attempt. */
  errors: { attempt: number; error: string; at: number }[];
}

/** A worker: receives the job's args (and the job record); throwing marks the attempt failed. */
export type Worker = (args: unknown, job: Job) => unknown | Promise<unknown>;

/** A running job queue — see {@link jobQueue}. */
export interface JobQueue {
  /**
   * Durably enqueue a job — persisted BEFORE the Task settles. Options mirror Oban's:
   * `queue` (default 'default'), `maxAttempts` (default 3), `scheduleIn` ms / `scheduledAt`
   * epoch-ms, `priority` (0 = most urgent), and `unique` (skip if an identical worker+args job
   * is already pending — returns the existing job). The returned Task is **eager** (the write is
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
    },
  ): Task<Job, AnyFailure>;
  /** The current record for a job id, or undefined (completed jobs are removed). */
  job(id: string): Job | undefined;
  /** Remove a pending job — Oban's `cancel_job`. A job already executing finishes its attempt. */
  cancelJob(id: string): Task<void, AnyFailure>;
  /** Stop starting jobs on `queue` (executing ones finish) — Oban's `pause_queue`. */
  pauseQueue(queue: string): void;
  /** Resume a paused queue. */
  resumeQueue(queue: string): void;
  /** Run everything currently runnable to completion — Oban's `drain_queue`, the test helper. */
  drain(): Task<void, AnyFailure>;
  /** Stop the scheduler (executing attempts finish; nothing new starts). */
  stop(): void;
}

/**
 * Build a {@link JobQueue}. `workers` maps worker names to functions; `queues` sets per-queue
 * concurrency (default `{ default: 10 }`); `backoff` maps a failed attempt count to a retry
 * delay in ms (default Oban's `attempt⁴ + 15s` shape); `pollMs` is the scheduler tick.
 *
 * ```ts
 * import { memoryStore } from '../node/index.ts';
 * const jobs = jobQueue({ store: memoryStore(), workers: {} });
 * typeof jobs.insert; // 'function'
 * jobs.stop();
 * ```
 */
export function jobQueue(options: {
  store: Store;
  workers: Record<string, Worker>;
  queues?: Record<string, number>;
  backoff?: (attempt: number) => number;
  pollMs?: number;
  keyPrefix?: string;
  /** Recurring jobs — Oban's Cron plugin: a cron expression (UTC) enqueues its job each time it
   *  matches. A schedule fires at most once per matching minute per instance; across a cluster,
   *  pass `leader` so only ONE node fires each schedule (else every node would). Give an expression a
   *  LIST of entries to run several workers on the same schedule (Oban allows duplicate crontab
   *  rows; a record key can't repeat, so the array value is the JS-shaped equivalent). */
  cron?: Record<string, CronEntry | CronEntry[]>;
  /** Cluster leadership for cron — Oban's `Peer`. When set, this instance evaluates cron only while
   *  it holds the lease, so a schedule enqueues exactly once cluster-wide. See {@link leader}. */
  leader?: Leader;
  /** Injectable wall-clock (epoch ms) — for deterministic scheduling/cron/backoff tests. */
  now?: () => number;
}): JobQueue {
  const queues = options.queues ?? { default: 10 };
  const backoff = options.backoff ?? ((attempt) => 1000 * attempt ** 4 + 15_000);
  const pollMs = options.pollMs ?? 50;
  const now = options.now ?? (() => Date.now());
  const prefix = options.keyPrefix ?? 'jobs';
  const jobKey = (id: string) => `${prefix}:${id}`;
  const INDEX = `${prefix}:index`;

  // The in-memory truth; the store mirrors it durably (job first, then index — an orphaned job
  // key from a crash between the two writes is simply ignored on load).
  const jobs = new Map<string, Job>();
  const executing = new Map<string, number>(); // queue -> running count
  const paused = new Set<string>();
  const seenQueues = new Set<string>(['default']); // queues to poll (configured + inserted-into)
  let alive = true;

  const persistJob = (job: Job): Promise<void> => options.store.save(jobKey(job.id), job);
  const persistIndex = (): Promise<void> => options.store.save(INDEX, [...jobs.keys()]);
  const removeJob = async (id: string): Promise<void> => {
    jobs.delete(id);
    await persistIndex(); // index first — a crash leaves an ignorable orphan key, never a ghost id
    await options.store.clear(jobKey(id));
  };

  // Crash recovery: reload every indexed job; one stuck `executing` was orphaned by a dead
  // process — rescue it back to available so it runs again (Oban's rescuer).
  const loaded: Promise<void> = (async () => {
    const ids = ((await options.store.load(INDEX)) as string[] | undefined) ?? [];
    for (const id of ids) {
      const job = (await options.store.load(jobKey(id))) as Job | undefined;
      if (!job) continue;
      if (job.state === 'executing') {
        job.state = 'available';
        await persistJob(job);
      }
      jobs.set(job.id, job);
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
    const meta = { worker: job.worker, queue: job.queue, id: job.id, attempt: job.attempt };
    const started = performance.now();
    emit(['jobs', 'execute', 'start'], {}, meta);
    try {
      await options.workers[job.worker]?.(job.args, job);
      emit(['jobs', 'execute', 'stop'], { duration: performance.now() - started }, meta);
      await removeJob(job.id); // completed jobs are removed — the queue stays bounded
    } catch (error) {
      emit(['jobs', 'execute', 'exception'], { duration: performance.now() - started }, meta);
      job.errors.push({
        attempt: job.attempt,
        error: isFailure(error) ? `${error.code}: ${error.message}` : String(error),
        at: now(),
      });
      if (job.attempt >= job.maxAttempts) {
        job.state = 'discarded'; // kept, with its errors — the dead-letter record
      } else {
        job.state = 'retryable';
        job.scheduledAt = now() + backoff(job.attempt);
      }
      await persistJob(job);
    } finally {
      executing.set(job.queue, (executing.get(job.queue) ?? 1) - 1);
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
    },
  ): Promise<Job> => {
    if (opts.unique) {
      const signature = JSON.stringify([worker, args]);
      for (const existing of jobs.values()) {
        if (JSON.stringify([existing.worker, existing.args]) === signature) return existing;
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
      errors: [],
    };
    jobs.set(job.id, job);
    seenQueues.add(job.queue); // so the drain loop polls this queue even if it wasn't configured
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
          unique: true, // a second tick in the same minute can't double-enqueue
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
    const due = [...jobs.values()]
      .filter((job) => job.queue === queue && runnable(job, now()))
      .sort((a, b) => a.priority - b.priority || a.scheduledAt - b.scheduledAt)
      .slice(0, demand);
    for (const job of due) {
      job.state = 'executing';
      job.attempt++;
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
  const tick = (): Promise<number> => {
    const result = tail.then(runTick);
    tail = result.catch(() => {});
    return result;
  };
  const timer = setInterval(() => void tick(), pollMs);
  (timer as { unref?: () => void }).unref?.();
  void loaded.then(() => tick()); // rescued + peer work starts once reload finishes

  return {
    insert(worker, args = {}, opts = {}) {
      return Task(async () => {
        await loaded;
        return doInsert(worker, args, opts);
      }).perform();
    },
    job: (id) => jobs.get(id),
    cancelJob(id) {
      return Task(async () => {
        const job = jobs.get(id);
        if (job && job.state !== 'executing') await removeJob(id);
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
    },
  };
}
