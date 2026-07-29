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
 * **Recurring cron** (Oban's Cron plugin): pass `cron` — each expression enqueues its job every
 * matching UTC minute. Divergence: the executor is per-process — Oban coordinates competing nodes
 * through Postgres row locks, which a plain key-value {@link Store} cannot express. To run ONE
 * queue (or its cron) across a cluster, make it a singleton with the primitives already here:
 * claim a registry key (`node.register('jobs', 'runner', onConflict)`) and only `resumeQueue`
 * while you own it.
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
   *  matches. A schedule fires at most once per matching minute. Cron is out of scope for a
   *  clustered singleton — run the queue's cron on ONE node (claim a registry key). Give an
   *  expression a LIST of entries to run several workers on the same schedule (Oban allows duplicate
   *  crontab rows; a record key can't repeat, so the array value is the JS-shaped equivalent). */
  cron?: Record<string, CronEntry | CronEntry[]>;
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
    job.state = 'executing';
    job.attempt++;
    executing.set(job.queue, (executing.get(job.queue) ?? 0) + 1);
    await persistJob(job); // an attempt is on the record before it runs — that's what rescue keys on
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
    await persistJob(job); // durable BEFORE the caller is told "queued"
    await persistIndex();
    queueMicrotask(tick); // run it now if a slot is free — the poll is only the backstop
    return job;
  };

  // Cron: at most one enqueue per schedule per matching UTC minute (tracked by minute bucket).
  const cronFired = new Map<string, number>();
  const evaluateCron = (clock: number): void => {
    if (!options.cron) return;
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

  // The scheduler: fire due cron schedules, then fill each queue's free slots, most urgent first.
  const tick = (): void => {
    if (!alive) return;
    const clock = now();
    evaluateCron(clock);
    const due = [...jobs.values()]
      .filter((job) => runnable(job, clock))
      .sort((a, b) => a.priority - b.priority || a.scheduledAt - b.scheduledAt);
    for (const job of due) {
      const limit = queues[job.queue] ?? queues.default ?? 10;
      if ((executing.get(job.queue) ?? 0) >= limit) continue;
      void run(job);
    }
  };
  const timer = setInterval(tick, pollMs);
  (timer as { unref?: () => void }).unref?.();
  void loaded.then(tick); // rescued work starts as soon as the reload finishes

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
      tick();
    },
    drain() {
      return Task(async () => {
        await loaded;
        for (;;) {
          tick();
          const clock = now();
          const busy = [...executing.values()].some((count) => count > 0);
          const pending = [...jobs.values()].some((job) => runnable(job, clock));
          if (!busy && !pending) return;
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
