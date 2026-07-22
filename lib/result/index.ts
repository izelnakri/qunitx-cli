// Barrel assembling the `Result` namespace: import * as Result from '.../result/index.ts'.
// A single-action file contributes a bare verb (Result.attempt); a multi-operation file
// contributes a sub-namespace (Result.Failure.define).
//
// Both access styles are supported and neither is a second-class citizen:
//
//   import * as Result from './lib/result/index.ts';
//   Result.attempt(() => JSON.parse(raw), SyntaxError);
//
//   import { attempt, ok, err, type Result } from './lib/result/index.ts';
//   attempt(() => JSON.parse(raw), SyntaxError);
//
// The type `Result<T, E>` and the namespace `Result` coexist deliberately: TypeScript keeps
// type and value namespaces separate, so `Result.ok()` and `const r: Result<T, E>` both
// resolve even when the same identifier is bound to each.
export {
  type Result,
  type Ok,
  type Err,
  type Success,
  type Failed,
  ok,
  err,
  isOk,
  isErr,
  isResult,
  unwrap,
  unwrapOr,
  unwrapOrElse,
  expect,
  match,
  map,
  mapErr,
  andThen,
  all,
  partition,
} from './result.ts';

export {
  type Matcher,
  type ErrnoError,
  attempt,
  pcall,
  xpcall,
  errno,
  instanceOf,
  anyOf,
} from './attempt.ts';

/** Structured, discriminable errors — the `E` half of `Result<T, E>`. */
export * as Failure from './failure.ts';
