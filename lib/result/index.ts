// Barrel assembling the `Result` namespace: import * as Result from '.../result/index.ts'.
// A single-action file contributes a bare verb (Result.attempt); a multi-operation file
// contributes a sub-namespace (Result.Failure.define).
//
// Both access styles are supported and neither is a second-class citizen:
//
//   import * as Result from './lib/result/index.ts';
//   Result.try(JSON.parse, raw);
//
//   import { attempt, ok, err, type Result } from './lib/result/index.ts';
//   attempt(JSON.parse, raw);
//
// The type `Result<T, E>` and the namespace `Result` coexist deliberately: TypeScript keeps
// type and value namespaces separate, so `Result.ok()` and `const r: Result<T, E>` both
// resolve even when the same identifier is bound to each.
export {
  type Result,
  type Ok,
  type Err,
  ok,
  err,
  isResult,
  unwrap,
  unwrapOr,
  expect,
  all,
  partition,
} from './result.ts';

export {
  type ErrnoError,
  attempt,
  // `Result.try(fn, ...args)` is the primary spelling — `Promise.try`'s shape, reflecting
  // into a Result; `attempt` is the same function under a name that also survives a bare
  // `import { attempt }` (`try` is a reserved word).
  attempt as try,
  isErrno,
} from './attempt.ts';

// There is deliberately no AsyncResult here. The awaitable, chainable producer half of the
// system is `Task` (`lib/task/`): a real lazy Promise whose `.result()` settles to the same
// plain `Result` this module defines — one async abstraction, not two.

/** Structured, discriminable errors — the `E` half of `Result<T, E>`. */
export * as Failure from './failure.ts';
