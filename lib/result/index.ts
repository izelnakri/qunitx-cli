// Barrel assembling the `Result` namespace: import * as Result from '.../result/index.ts'.
// Boundary verbs land flat on the namespace (Result.try, Result.isErrno); the failure
// taxonomy is its own cohesive noun-module, so it stays a sub-namespace (Result.Failure.define).
//
// Both access styles are supported and neither is a second-class citizen:
//
//   import * as Result from './lib/result/index.ts';
//   Result.try(JSON.parse, raw);
//
//   import { tryCatch, unwrap, type Result } from './lib/result/index.ts';
//   tryCatch(JSON.parse, raw);
//
// The type `Result<T, E>` and the namespace `Result` coexist deliberately: TypeScript keeps
// type and value namespaces separate, so `Result.ok()` and `const r: Result<T, E>` both
// resolve even when the same identifier is bound to each.
export { type Result, unwrap, unwrapOr, expect, all, partition } from './result.ts';

export {
  type ErrnoError,
  type Ok,
  type Err,
  type Caught,
  tryCatch,
  // `Result.try(fn, ...args)` is the primary spelling — `Promise.try`'s shape, reflecting
  // into a Result; `tryCatch` is the same function under a name that also survives a bare
  // `import { tryCatch }` (`try` alone is a reserved word, and this boundary is exactly
  // where the try/catch keyword pair lives).
  tryCatch as try,
  // The boundary and the declaration fused: value bare, throw classified into a declared
  // Failure — the sync sibling of Task#mapErr, for when the flat rethrow line would only
  // restate "any throw here becomes this failure".
  rescue,
  type Rescued,
  isErrno,
} from './try.ts';

// There is deliberately no AsyncResult here. The awaitable, chainable producer half of the
// system is `Task` (`lib/task/`): a real lazy Promise whose `.result()` settles to the same
// plain `Result` this module defines — one async abstraction, not two.

/**
 * Structured, discriminable errors — the `E` half of `Result<T, E>`.
 *
 * ```ts
 * import * as Failure from './failure.ts';
 * const FileMissing = Failure.define('FileMissing', (d: { path: string }) => `no ${d.path}`);
 * FileMissing.is(FileMissing({ path: 'a.ts' })); // true
 * ```
 */
export * as Failure from './failure.ts';
