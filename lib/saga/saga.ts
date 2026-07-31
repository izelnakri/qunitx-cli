/**
 * `saga` — Elixir's **`Sage`**: multi-entity distributed transactions with **compensation**, the
 * honest answer above single-key {@link Store} atomicity. A saga is a sequence of steps, each a
 * forward action plus an undo (its *compensation*). Steps run in order, threading a shared context;
 * if any step fails, the saga runs the compensations for every ALREADY-COMPLETED step **in reverse**
 * — so "debit A, credit B, book C" leaves the world consistent even when C fails (un-credit B,
 * un-debit A). It's the distributed-systems substitute for a 2-phase commit you can't have across
 * independent services or entity actors.
 *
 * With a {@link Store} the completed-step log is **durable**, so a saga stranded by a crash mid-flight
 * can be rolled back later with {@link SagaHandle.recover} — the guarantee that makes it safe for
 * money-grade workflows. Compensations must be **idempotent** (a recovery may re-run one): that's
 * the single contract the caller owns, and it's the same one every saga library requires.
 *
 * ```ts
 * const log: string[] = [];
 * const booking = saga<{ seat?: string; charge?: string }>([
 *   {
 *     name: 'reserve',
 *     run: () => (log.push('reserve'), 'seat-7'),
 *     compensate: () => void log.push('release-seat'),
 *   },
 *   {
 *     name: 'charge',
 *     run: () => {
 *       log.push('charge');
 *       throw new Error('card declined'); // the payment fails…
 *     },
 *     compensate: () => void log.push('refund'),
 *   },
 * ]);
 * const result = await booking.execute({});
 * result.ok; // false
 * log; // ['reserve', 'charge', 'release-seat'] — the reserved seat was compensated back
 * ```
 */
import { Failure } from '../result/index.ts';
import type { Any as AnyFailure } from '../result/failure.ts';
import { Task } from '../task/task.ts';
import type { Store } from '../node/store.ts';

/** One saga step: a forward action, its compensation, and an optional retry count. */
export interface Step<Ctx extends object> {
  /** Unique step name — its result is threaded into the context under this key. */
  name: string;
  /** The forward action; its return value is stored in the context and passed to `compensate`. */
  run(ctx: Ctx): unknown | Promise<unknown>;
  /** Undo this step — runs (in reverse order) if a LATER step fails. Must be idempotent. */
  compensate?(result: unknown, ctx: Ctx): void | Promise<void>;
  /** Retry the forward action this many times before the step is considered failed (default 0). */
  retries?: number;
}

/** The outcome of executing a saga. */
export type SagaResult<Ctx> =
  { ok: true; ctx: Ctx } | { ok: false; failedAt: string; error: unknown; compensated: string[] };

/** A prepared saga — see {@link saga}. */
export interface SagaHandle<Ctx extends object> {
  /** Run the saga forward from `initial`; on a step failure, compensate completed steps in reverse.
   *  Eager Task: the saga is running before you await, and `.result()`/`.match()` compose. */
  execute(initial: Ctx): Task<SagaResult<Ctx>, AnyFailure>;
  /** Roll back a saga stranded by a crash: load its durable log and compensate its completed steps. */
  recover(initial: Ctx): Task<SagaResult<Ctx>, AnyFailure>;
}

interface Progress {
  completed: { name: string; result: unknown }[];
}

/**
 * Prepare a {@link SagaHandle} from `steps`. Pass a {@link Store} + `id` to make the completed-step
 * log durable (enabling {@link SagaHandle.recover} after a crash); without one the saga is
 * in-memory only.
 *
 * ```ts
 * const s = saga<{ a?: number }>([{ name: 'a', run: () => 1 }]);
 * (await s.execute({})).ok; // true
 * ```
 */
export function saga<Ctx extends object>(
  steps: Step<Ctx>[],
  options: { store?: Store; id?: string } = {},
): SagaHandle<Ctx> {
  const storeKey = `saga:${options.id ?? 'anon'}`;
  const persist = (progress: Progress): Promise<void> =>
    options.store ? options.store.save(storeKey, progress) : Promise.resolve();
  const forget = (): Promise<void> =>
    options.store ? options.store.clear(storeKey) : Promise.resolve();

  // Run a step's forward action, retrying up to `retries` times.
  const runStep = async (step: Step<Ctx>, ctx: Ctx): Promise<unknown> => {
    let attempt = 0;
    for (;;) {
      try {
        return await step.run(ctx);
      } catch (error) {
        if (attempt++ >= (step.retries ?? 0)) throw error;
      }
    }
  };

  // Compensate `completed` steps in REVERSE order; every compensation is attempted even if one
  // throws (best-effort rollback), and the list of the ones we ran is returned.
  const rollback = async (completed: Progress['completed'], ctx: Ctx): Promise<string[]> => {
    const byName = new Map(steps.map((s) => [s.name, s]));
    const compensated: string[] = [];
    for (let i = completed.length - 1; i >= 0; i--) {
      const { name, result } = completed[i];
      try {
        await byName.get(name)?.compensate?.(result, ctx);
      } catch {
        // a compensation failing must not abort the rest of the rollback
      }
      compensated.push(name);
    }
    return compensated;
  };

  return {
    execute(initial) {
      return Task<SagaResult<Ctx>>(async () => {
        const ctx = { ...initial } as Ctx;
        const progress: Progress = { completed: [] };
        for (const step of steps) {
          let result: unknown;
          try {
            result = await runStep(step, ctx);
          } catch (error) {
            const compensated = await rollback(progress.completed, ctx);
            await forget();
            return { ok: false, failedAt: step.name, error, compensated };
          }
          (ctx as Record<string, unknown>)[step.name] = result;
          progress.completed.push({ name: step.name, result });
          await persist(progress); // durable AFTER the forward action, BEFORE the next step
        }
        await forget(); // a fully-committed saga leaves no rollback log
        return { ok: true, ctx };
      }).perform();
    },

    recover(initial) {
      return Task<SagaResult<Ctx>>(async () => {
        const progress = (await options.store?.load(storeKey)) as Progress | undefined;
        if (!progress || progress.completed.length === 0) {
          await forget();
          return { ok: true, ctx: { ...initial } as Ctx }; // nothing stranded
        }
        const ctx = { ...initial } as Ctx;
        for (const { name, result } of progress.completed)
          (ctx as Record<string, unknown>)[name] = result;
        const compensated = await rollback(progress.completed, ctx);
        await forget();
        return {
          ok: false,
          failedAt: progress.completed.at(-1)!.name,
          error: Failure.is(progress) ? progress : new Error('recovered after crash'),
          compensated,
        };
      }).perform();
    },
  };
}
