import { is, format, hasCode, type Any } from '../result/failure.ts';

/**
 * A declared failure: something the runner decided it could not do, carrying a `code` you can
 * branch on and a `message` you can show.
 *
 * ```ts
 * // Defined, not invoked: real failures come back from `run(...).result()`.
 * function codeOf(failure: AnyFailure) {
 *   return failure.code; // 'InvalidOption' | 'ProjectRootNotFound' | …
 * }
 * ```
 */
export type AnyFailure = Any;

/**
 * The failure taxonomy, as the JS API's public surface.
 *
 * Deliberately a hand-written subset rather than the whole internal module re-exported: these
 * three are what a consumer needs to handle a failure, and freezing only them keeps the rest —
 * `define`, the tracing hooks, the ignore channel — free to change without breaking anyone.
 *
 * ```ts
 * import { Failure } from './failure.ts';
 *
 * Failure.is(new Error('plain')); // false — only declared failures answer to this
 * ```
 */
export const Failure: {
  /**
   * Narrows an unknown value to a declared failure. The guard to reach for after `.result()`.
   */
  is: (value: unknown) => value is AnyFailure;
  /** Renders a failure as the one-line message the CLI would print. */
  format: (error: unknown, options?: { stacks?: boolean }) => string;
  /** Narrows to a specific set of codes, for handling some failures and rethrowing the rest. */
  hasCode: <const Codes extends readonly string[]>(
    value: unknown,
    ...codes: Codes
  ) => value is AnyFailure & { code: Codes[number] };
} = { is, format, hasCode };
