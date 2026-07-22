/**
 * `Failure` — the taxonomy half of the error system.
 *
 * A Failure is an `Error` subclass with two additions that make it usable as the `E` of a
 * `Result<T, E>`:
 *
 *  - **`code`**, a string literal discriminant. Narrowing is a `switch` on a string, so it
 *    works on a value that arrived over a WebSocket, out of a Worker, or from `JSON.parse` —
 *    all places where `instanceof` is unreliable or outright wrong.
 *  - **`data`**, a typed payload. The throw site already knows the path it could not read or
 *    the field that failed validation; `data` is where that goes, so the catch site never has
 *    to recover it by pattern-matching the message. (This codebase has a live example of the
 *    alternative: `deriveBuildErrorType()` in `lib/commands/run/tests-in-browser.ts` runs four
 *    regexes over `error.message` to re-derive a category esbuild knew all along.)
 *
 * Failure stays an `Error` subclass rather than becoming a plain tagged object because too
 * much of the ecosystem keys off it: Node's `util.inspect`, browser devtools' "expand the
 * stack" affordance, `unhandledRejection` diagnostics, and every logger's error branch. The
 * cost is that a Failure is *not* plain data — hence `toJSON`/`fromJSON` below, which are
 * mandatory at any boundary a Result crosses. Only the `Result` wrapper is plain data by
 * construction; the error inside it needs explicit help.
 *
 * @see docs/error-handling.md for the full rationale and the corner-case catalogue.
 */

// `Symbol.for` (not `Symbol()`) because the registry it reads from is per-process, not
// per-realm: a Failure constructed inside a Worker, a `vm` context, or an iframe carries a
// key that compares equal to the one used here. `instanceof Failure` fails across every one
// of those boundaries, because each realm has its own `Failure` binding and its own
// `Error.prototype`. This brand is the cross-realm identity that `instanceof` cannot be.
const FAILURE_BRAND: unique symbol = Symbol.for('result.Failure') as never;

// `Error.captureStackTrace` and `Error.stackTraceLimit` are V8 extensions, absent on
// SpiderMonkey and JavaScriptCore. Everything gated on this has a correct slower path —
// which matters here, because this project runs its own tests in firefox and webkit.
const HAS_CAPTURE = typeof Error.captureStackTrace === 'function';

/** The wire form of a Failure — what `toJSON` emits and `fromJSON` accepts. */
export interface SerializedFailure {
  /**
   * Wire marker. `Symbol.for` keys survive neither `JSON.stringify` nor `structuredClone`,
   * so the serialized form carries an explicit field in the brand's place.
   *
   * It is load-bearing rather than decorative: without it the structural check in
   * `isFailure()` would have to accept "has a string `code` and a string `message`", and
   * *every Node system error* satisfies that — an `ENOENT` would report itself as a Failure
   * and `error.data` would silently read `undefined` from there on.
   */
  failure: true;
  /** The discriminant. Survives the wire, unlike a prototype. */
  code: string;
  /** The human-readable sentence, already interpolated from `data`. */
  message: string;
  /** The structured payload, JSON round-tripped by `toJSON` so it cannot fail later. */
  data: unknown;
  /** The *producing* process's stack. Absent for a stackless failure. */
  stack?: string;
  /** The serialized cause chain: a nested Failure, or a plain error's identifying fields. */
  cause?: SerializedFailure | { name: string; message: string; stack?: string };
}

/** Options accepted by the `Failure` constructor and by every generated factory. */
export interface FailureOptions {
  /** The error this failure was derived from. Preserved verbatim and walked by `causes()`. */
  cause?: unknown;
  /**
   * Skips stack capture. Only worth setting for failures produced in a hot loop and consumed
   * immediately — the capture, not the allocation, is what a Failure costs. See the
   * performance section of the docs before reaching for it.
   */
  stackless?: boolean;
  /**
   * The function to truncate the stack at, so the top frame is the code that *reported* the
   * failure rather than the plumbing that built it. Defaults to the constructor.
   *
   * Anything that wraps `define()` in another layer needs this, and so does `define()`
   * itself: eliding only the constructor leaves the factory's own frame on top, which
   * is how a Failure ends up pointing at `failure.ts` instead of at the caller.
   */
  stackAnchor?: (...args: never[]) => unknown;
}

/**
 * A structured, discriminable error.
 *
 * Construct these through `define()` rather than directly: the factory is what pins `code`
 * to a literal type and gives you a matching type guard.
 */
export class Failure<Code extends string = string, Data = undefined> extends Error {
  /** Cross-realm brand read by `isFailure()`. Non-enumerable so it never reaches the wire. */
  declare readonly [FAILURE_BRAND]: true;

  /** The discriminant. Narrow on this, never on `instanceof`. */
  readonly code: Code;

  /** Structured payload supplied by the throw site. */
  readonly data: Data;

  /** Prefer `define()`, which pins `code` to a literal type and supplies the stack anchor. */
  constructor(code: Code, message: string, data: Data, options: FailureOptions = {}) {
    // `cause` goes through the Error options bag rather than a manual assignment so it lands
    // as the spec-defined own property — which is what Node's inspector, browser devtools,
    // and every `cause`-walking logger already know how to render.
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.code = code;
    this.data = data;
    // `name` drives the first token of the default `stack` string, so setting it to the code
    // makes an unhandled Failure self-identify in a raw log line with no formatter involved.
    this.name = `Failure(${code})`;

    Object.defineProperty(this, FAILURE_BRAND, {
      value: true,
      enumerable: false,
      writable: false,
    });

    if (options.stackless) {
      // Assigning a plain string is what actually avoids the cost: V8 captures the structured
      // frames eagerly inside the `Error` constructor and only *formats* them lazily, so the
      // frames were already collected by the `super()` call above. Overwriting releases them.
      this.stack = `${this.name}: ${message}`;
    } else if (Error.captureStackTrace) {
      // Truncates the trace above the anchor so the top frame is the code that reported the
      // failure, not the plumbing that built it. V8/Node only; other engines keep the raw
      // trace, which is merely noisier rather than wrong.
      Error.captureStackTrace(this, options.stackAnchor ?? this.constructor);
    }
  }

  /** Serializes to plain JSON so `console.log(JSON.stringify(failure))` is not `{}`. */
  toJSON(): SerializedFailure {
    return toJSON(this);
  }
}

/**
 * Any Failure at all — the type to reach for when a signature accepts failures it does not
 * enumerate, e.g. `Result<T, Failure.Any>` at a boundary that only logs.
 */
export type Any = Failure<string, unknown>;

/**
 * The Failure type a factory produces: `Failure.Of<typeof FileMissing>`.
 *
 * Lets a function signature name its failure modes by pointing at the declarations rather
 * than restating their code and payload — `Result<Config, Failure.Of<typeof FileMissing | typeof Invalid>>`.
 */
export type Of<F> = F extends FailureFactory<infer Code, infer Data> ? Failure<Code, Data> : never;

/** A callable failure constructor produced by `define()`, carrying its own type guard. */
export interface FailureFactory<Code extends string, Data> {
  (data: Data, options?: FailureOptions): Failure<Code, Data>;
  /** The literal code this factory produces. Useful as a `switch` case and in registries. */
  readonly code: Code;
  /** Cross-realm type guard narrowing to this exact failure. Usable as an `attempt()` matcher. */
  is(value: unknown): value is Failure<Code, Data>;
}

/** `define()` overload for failures that carry no payload. */
export function define<Code extends string>(
  code: Code,
  message: string,
): FailureFactory<Code, undefined> &
  ((data?: undefined, options?: FailureOptions) => Failure<Code, undefined>);
/** `define()` overload for failures whose message is derived from their payload. */
export function define<Code extends string, Data>(
  code: Code,
  message: (data: Data) => string,
): FailureFactory<Code, Data>;
/**
 * Declares a failure kind once and returns its constructor.
 *
 * ```ts
 * const FileMissing = define('FileMissing', (d: { path: string }) => `no such file: ${d.path}`);
 *
 * FileMissing({ path: 'a.ts' });      // Failure<'FileMissing', { path: string }>
 * FileMissing.is(someCaughtValue);    // type guard, cross-realm safe
 * FileMissing.code;                   // 'FileMissing'
 * ```
 *
 * The message is a *function of the payload* rather than a pre-interpolated string so that
 * the structured `data` and the human sentence can never disagree, and so nothing has to be
 * formatted for failures that end up handled silently.
 */
export function define<Code extends string, Data>(
  code: Code,
  message: string | ((data: Data) => string),
): FailureFactory<Code, Data> {
  const factory = (data: Data, options?: FailureOptions): Failure<Code, Data> => {
    // Computed outside the window below because it is caller-supplied code: anything it
    // throws must still get a stack trace of its own.
    const text = typeof message === 'function' ? message(data) : message;
    if (!HAS_CAPTURE) return new Failure(code, text, data, { stackAnchor: factory, ...options });

    // `super(message)` captures a trace unconditionally in V8, so anchoring the stack at the
    // factory would capture a *second* one — measured at almost exactly 2x a plain
    // `new Error()`, since capture is ~94% of what an Error costs. Zeroing the limit across
    // the constructor makes that first capture ~16x cheaper, which buys the anchor for free.
    // The window is safe to leave global: it is fully synchronous, contains no `await` and no
    // caller code, and `finally` restores the limit even if construction throws.
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    let failure: Failure<Code, Data>;
    try {
      failure = new Failure(code, text, data, { ...options, stackless: true });
    } finally {
      Error.stackTraceLimit = limit;
    }
    if (!options?.stackless) Error.captureStackTrace(failure, factory);
    return failure;
  };

  return Object.assign(factory, {
    code,
    is: (value: unknown): value is Failure<Code, Data> => isFailure(value) && value.code === code,
  });
}

/**
 * Whether `value` is a Failure — from this realm or any other.
 *
 * The brand lookup is the primary test. The structural fallback covers the one case a brand
 * cannot: `toJSON` output revived by something other than `fromJSON` — a JSON round trip
 * through a cache, a WebSocket frame handed straight to application code — which keeps the
 * fields but loses both the prototype and the non-enumerable brand.
 *
 * Note what is deliberately *not* covered: `structuredClone(failure)`. The structured clone
 * algorithm handles `Error` objects by preserving `name`, `message`, `stack` and `cause` and
 * discarding both the subclass and every own property — so `code` and `data` are simply gone,
 * and answering `true` here would be a lie. Serialize with `toJSON`, not `structuredClone`.
 */
export function isFailure(value: unknown): value is Any {
  if (typeof value !== 'object' || value === null) return false;
  if ((value as Record<symbol, unknown>)[FAILURE_BRAND] === true) return true;
  return (
    (value as SerializedFailure).failure === true && typeof (value as Failure).code === 'string'
  );
}

// Under the intended namespace import (`import * as Failure from './failure.ts'`) the guard
// reads `Failure.is(value)`; the longer name is kept as well for flat imports, where a bare
// `is(value)` would say nothing about what is being tested.
export { isFailure as is };

/**
 * Narrows a Failure to one of several codes — the multi-code sibling of `Factory.is`.
 *
 * ```ts
 * if (hasCode(error, 'FileMissing', 'PermissionDenied')) error.code; // 'FileMissing' | 'PermissionDenied'
 * ```
 */
export function hasCode<const Codes extends readonly string[]>(
  value: unknown,
  ...codes: Codes
): value is Failure<Codes[number], unknown> {
  return isFailure(value) && (codes as readonly string[]).includes(value.code);
}

// ── Normalizing arbitrary throwables ─────────────────────────────────────────

/** The failure `from()` produces for a throwable that is not already a Failure. */
export const Unknown = define('Unknown', (data: { thrown: unknown }) =>
  data.thrown instanceof Error ? data.thrown.message : `non-Error thrown: ${label(data.thrown)}`,
);

/**
 * Coerces any caught value into a Failure, leaving existing Failures untouched.
 *
 * Necessary because `throw` accepts every value in JS — `throw 'nope'`, `throw undefined`,
 * `throw { code: 42 }` are all legal and all occur in the wild (DOM callbacks, old libraries,
 * and any `Promise.reject(someNonError)`). The original is preserved under `cause` rather
 * than being flattened into a string, so nothing is lost on the way through.
 */
export function from(thrown: unknown): Any {
  if (isFailure(thrown)) return thrown;
  return Unknown({ thrown }, { cause: thrown });
}

// ── Deliberate non-handling ──────────────────────────────────────────────────

// Debug output is gated on the same env var the CLI's --debug flag sets, read once. These
// call sites are in cleanup paths that run with no config in scope (temp-dir removal, socket
// teardown), so threading `config.debug` to them is not an option.
const DEBUG = Boolean(process.env.QUNITX_DEBUG);

/**
 * Builds a `.catch()` handler for a failure that genuinely has no consequence — but says so
 * under `QUNITX_DEBUG` instead of vanishing.
 *
 * This is the counterpart to `Result`, not a lesser version of it. A `Result` is for a failure
 * the caller branches on; unlinking a temp directory that is already gone is not that, and
 * wrapping it would add ceremony while removing nothing (see the "when not to use this"
 * section of `docs/error-handling.md`).
 *
 * What it does fix is that `.catch(() => {})` is indistinguishable from `.catch(() => {})`.
 * A real `EACCES` on a directory qunitx is trying to clean up, and a benign `ENOENT` because
 * it was already cleaned up, currently produce identical silence — inside code whose entire
 * job is diagnosing why a directory will not delete.
 *
 * ```ts
 * await unlink(socketPath).catch(ignore('daemon socket unlink'));
 * ```
 */
export function ignore(context: string): (error: unknown) => void {
  return (error: unknown) => {
    if (!DEBUG) return;
    // stderr, not stdout: stdout is the TAP stream and a stray line there corrupts the report.
    process.stderr.write(`# [qunitx] ignored (${context}): ${format(error)}\n`);
  };
}

// ── Cause chains ─────────────────────────────────────────────────────────────

// Bounds the walk so a self-referential or cyclic `cause` cannot hang the formatter. Cycles
// are rare but entirely constructible (`a.cause = b; b.cause = a`), and a logger is the last
// place that should be able to lock up a process.
const MAX_CAUSE_DEPTH = 32;

/**
 * Flattens an error's `cause` chain into an array, `error` first and the root cause last.
 *
 * Cycle-safe and depth-bounded: a repeated reference terminates the walk instead of looping.
 */
export function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current != null && chain.length < MAX_CAUSE_DEPTH && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** The deepest `cause` in the chain — the original failure, whatever wrapped it since. */
export function rootCause(error: unknown): unknown {
  return causes(error).at(-1);
}

/**
 * Renders an error and its whole `cause` chain as indented, human-readable lines.
 *
 * Node's own `util.inspect` renders `cause` chains well, but only for real `Error` objects
 * and only when something calls it — this works on revived wire failures too, and is what
 * you want in a TAP comment or a CLI's stderr block where a full stack would be noise.
 */
export function format(error: unknown, { stacks = false }: { stacks?: boolean } = {}): string {
  return causes(error)
    .map((link, depth) => {
      const indent = '  '.repeat(depth);
      const prefix = depth === 0 ? '' : 'caused by: ';
      const head = isFailure(link)
        ? `${link.code}: ${link.message}`
        : link instanceof Error
          ? `${link.name}: ${link.message}`
          : label(link);
      const trace =
        stacks && link instanceof Error && link.stack
          ? link.stack
              .split('\n')
              .slice(1)
              .map((line) => `${indent}  ${line.trim()}`)
              .join('\n')
          : '';
      return `${indent}${prefix}${head}${trace ? `\n${trace}` : ''}`;
    })
    .join('\n');
}

// ── Serialization ────────────────────────────────────────────────────────────

/**
 * Converts a Failure (or any error) into plain JSON.
 *
 * This exists because `JSON.stringify(new Error('boom'))` is `{}`: `message` and `stack` are
 * own-but-non-enumerable, and `name` lives on the prototype. Anything that ships an error
 * over a WebSocket, a `postMessage`, or an HTTP response body has to do this conversion —
 * the alternative is the silent data loss where a caught error arrives on the far side as an
 * empty object and every downstream `error.code` check reads `undefined`.
 *
 * `structuredClone` handles native errors better than JSON does (it preserves `name`,
 * `message`, `stack`, and `cause`) but still drops the prototype and *every own property you
 * added* — so `code` and `data` would not survive it either. Use this, not `structuredClone`,
 * for Failures.
 */
export function toJSON(error: unknown): SerializedFailure {
  const failure = from(error);
  const cause = failure.cause;
  return {
    failure: true,
    code: failure.code,
    message: failure.message,
    // Round-trip the payload through JSON eagerly so an unserializable field (a function, a
    // BigInt, a circular reference) fails here — at the boundary, with the code in hand —
    // rather than inside the caller's `JSON.stringify` where the error would replace the
    // error being reported.
    data: safeData(failure.data),
    ...(failure.stack ? { stack: failure.stack } : {}),
    ...(cause == null ? {} : { cause: serializeCause(cause) }),
  };
}

/**
 * Revives a `SerializedFailure` into a real Failure, reconstructing the `cause` chain.
 *
 * The revived failure's `stack` is the *remote* stack — it names frames in the process that
 * produced the failure, not this one. That is a feature over a WebSocket boundary (it points
 * at the browser code that actually broke) and a trap if you forget it, so the docs call it
 * out explicitly.
 */
export function fromJSON(json: SerializedFailure): Any {
  const failure = new Failure(json.code, json.message, json.data, {
    stackless: true,
    ...(json.cause ? { cause: reviveCause(json.cause) } : {}),
  });
  if (json.stack) failure.stack = json.stack;
  return failure;
}

// ── Internals ────────────────────────────────────────────────────────────────

function serializeCause(cause: unknown): NonNullable<SerializedFailure['cause']> {
  if (isFailure(cause)) return toJSON(cause);
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      ...(cause.stack ? { stack: cause.stack } : {}),
    };
  }
  return { name: 'Thrown', message: label(cause) };
}

function reviveCause(cause: NonNullable<SerializedFailure['cause']>): unknown {
  if ('failure' in cause) return fromJSON(cause);
  const error = new Error(cause.message);
  error.name = cause.name;
  if (cause.stack) error.stack = cause.stack;
  return error;
}

function safeData(data: unknown): unknown {
  if (data === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return { unserializable: label(data) };
  }
}

/** One-line rendering of an arbitrary value that is guaranteed not to throw. */
function label(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'object') return Object.prototype.toString.call(value);
  return String(value);
}
