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
  type CatchOption,
  type ErrnoError,
  attempt,
  // `Result.try(fn, { catch: … })` is the primary spelling; `attempt` is the same function
  // under a name that also survives a bare `import { attempt }` (`try` is a reserved word).
  attempt as try,
  pcall,
  xpcall,
  errno,
  instanceOf,
  anyOf,
} from './attempt.ts';

export {
  AsyncResult,
  asyncResult,
  // `Result.from(promiseOfResult)` is the primary, `Array.from`-style spelling; `asyncResult`
  // is the same function under a name that survives a bare import (`from` reads oddly as a bare
  // local — `import { from } from '…'`). See the "why `from` is only a lift" note in
  // async-result.ts for what it deliberately does *not* do (it is not a throw-boundary).
  asyncResult as from,
} from './async-result.ts';

/** Structured, discriminable errors — the `E` half of `Result<T, E>`. */
export * as Failure from './failure.ts';
