// Barrel for the Task error-handling system.
//
//   import { Task, Failure, type Result } from '.../lib/task/index.ts';
//
// `Task<T>` is the awaitable — a Promise superset whose rejections carry a `Failure`.
// `Failure` is the taxonomy namespace (`Failure.define`, `Failure.is`, …).
// `Result` / `ok` / `err` / `partition` are the plain `{ ok, value, error }` value that
// `task.settle()` reflects to — the value half, reused from the existing module unchanged.
export { Task } from './task.ts';

/** Structured, discriminable failures — the rejection reason of a Task. */
export * as Failure from '../result/failure.ts';

export { type Result, type Ok, type Err, ok, err, isResult, partition } from '../result/result.ts';
