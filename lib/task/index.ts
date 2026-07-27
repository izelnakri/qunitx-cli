// Barrel for the Task error-handling system.
//
//   import { Task, Failure, type Result } from '.../lib/task/index.ts';
//
// `Task<T, E>` is the awaitable — a lazy, retryable Promise superset whose declared failures
// are `Failure` rejections. `Failure` is the taxonomy namespace (`Failure.define`,
// `Failure.is`, …). `Result<T, E>` is the bare `T | E` union that `task.result()` settles
// to — the value half, reused from lib/result unchanged; discriminate it with `Failure.is`.
export { Task } from './task.ts';

/**
 * Structured, discriminable failures — the rejection reason of a Task.
 *
 * ```ts
 * import * as Failure from '../result/failure.ts';
 * const Timeout = Failure.define('Timeout', (d: { ms: number }) => `timed out after ${d.ms}ms`);
 * Timeout.is(Timeout({ ms: 3000 })); // true
 * ```
 */
export * as Failure from '../result/failure.ts';

export { type Result, unwrap, partition } from '../result/result.ts';
