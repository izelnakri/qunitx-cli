// Barrel for the Task error-handling system.
//
//   import { Task, Failure, type Result } from '.../lib/task/index.ts';
//
// `Task<T, E>` is the awaitable — a lazy, retryable Promise superset whose declared failures
// are `Failure` rejections. `Failure` is the taxonomy namespace (`Failure.define`,
// `Failure.is`, …). `Result` / `ok` / `err` / `partition` are the plain `{ ok, value, error }`
// value that `task.result()` reflects to — the value half, reused from lib/result unchanged.
export { Task } from './task.ts';

/** Structured, discriminable failures — the rejection reason of a Task. */
export * as Failure from '../result/failure.ts';

export { type Result, type Ok, type Err, ok, err, isResult, partition } from '../result/result.ts';
