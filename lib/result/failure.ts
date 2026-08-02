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

/**
 * The wire form of a Failure — what `toJSON` emits and `fromJSON` accepts.
 */
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

/**
 * Options accepted by the `Failure` constructor and by every generated factory.
 */
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
 *
 * ```ts
 * const failure = new Failure('FileMissing', 'no such file: a.ts', { path: 'a.ts' });
 * failure.code; // 'FileMissing' — a literal type, so `switch` narrows
 * failure.data.path; // 'a.ts' — typed payload, no message parsing
 * failure instanceof Error; // true — devtools, loggers and `util.inspect` keep working
 * ```
 */
// `Data` defaults to `unknown` so that the unparameterised `Failure` type IS the top type of
// the taxonomy — every concrete `Failure<Code, Data>` is assignable to it. (An earlier
// `Data = undefined` default made bare `Failure` mean "carries no payload", which rejected
// nearly every real failure; nothing relied on it — the no-payload `define` overload spells
// `undefined` explicitly.)
export class Failure<Code extends string = string, Data = unknown> extends Error {
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

  /**
   * Serializes to plain JSON so `console.log(JSON.stringify(failure))` is not `{}`.
   *
   * ```ts
   * import * as Failure from './failure.ts';
   *
   * const Denied = Failure.define('Denied', 'permission denied');
   * JSON.stringify(Denied()); // JSON.stringify calls this — the full wire form, not '{}'
   * ```
   */
  toJSON(): SerializedFailure {
    return toJSON(this);
  }
}

/**
 * Any Failure at all — the type to reach for when a signature accepts failures it does not
 * enumerate, e.g. `Result<T, Failure.Any>` at a boundary that only logs.
 *
 * ```ts
 * import * as Failure from './failure.ts'; // the consumer spelling this module's docs use
 *
 * function report(failure: Failure.Any) {
 *   console.error(failure.code, failure.data); // every Failure has these, whatever its kind
 * }
 * ```
 *
 * Since `Data` defaults to `unknown`, this is the same type as an unparameterised `Failure`
 * — the alias earns its keep twice anyway. Under the standard `import * as Failure`
 * namespace import, the class type is not nameable without the stuttering `Failure.Failure`,
 * so `Failure.Any` is the spelling that reads. And §8.15 of the docs warns that widening to
 * the top type *early* silently discards exhaustiveness checking — because every deliberate
 * widening is spelled `Any`, `grep 'Failure.Any'` audits exactly where the taxonomy goes
 * un-enumerated.
 */
export type Any = Failure<string, unknown>;

/**
 * The Failure type a factory produces: `Failure.Of<typeof FileMissing>`.
 *
 * Lets a function signature name its failure modes by pointing at the declarations rather
 * than restating their code and payload:
 *
 * ```ts
 * import * as Failure from './failure.ts';
 * import * as Result from './result.ts';
 *
 * const GitScanFailed = Failure.define('GitScanFailed', (d: { ref: string }) => `bad ref: ${d.ref}`);
 * type GitScanFailure = Failure.Of<typeof GitScanFailed>;
 * //   ^? Failure<'GitScanFailed', { ref: string }>
 * const scan = (ref: string): Result.Result<string[], GitScanFailure> =>
 *   GitScanFailed({ ref }); // the failure IS the Result's failure arm — no wrapper
 * ```
 */
export type Of<F> = F extends FailureFactory<infer Code, infer Data> ? Failure<Code, Data> : never;

/**
 * A callable failure constructor produced by `define()`, carrying its own type guard.
 */
export interface FailureFactory<Code extends string, Data> {
  (data: Data, options?: FailureOptions): Failure<Code, Data>;
  /** The literal code this factory produces. Useful as a `switch` case and in registries. */
  readonly code: Code;
  /** Cross-realm type guard narrowing to this exact failure — the flat rethrow line's guard after a `Result.try`. */
  is(value: unknown): value is Failure<Code, Data>;
}

/**
 * The attribute primitives tracing systems accept (OpenTelemetry's span-attribute values) —
 * what a `trace` mapper returns and {@link attributes} yields.
 */
export type TraceAttributes = Record<string, string | number | boolean>;

/**
 * Per-kind options accepted by `define()`.
 */
export interface DefineOptions<Data> {
  /**
   * Allowlist mapper from the typed payload to span/log attributes, consumed by
   * {@link attributes}. Deliberately not a redaction filter: only what the mapper *returns*
   * is ever exposed, so sensitive fields are private by omission, not by scrubbing.
   */
  trace?: (data: Data) => TraceAttributes;
}

// Keyed by code (not by factory) so attributes() also resolves for failures that arrived
// cross-realm or through fromJSON. Registered by define(); re-defining a code replaces it.
const traceMappers = new Map<string, (data: unknown) => TraceAttributes>();

/** `define()` overload for failures that carry no payload. */
export function define<Code extends string>(
  code: Code,
  message: string,
  defineOptions?: DefineOptions<undefined>,
): FailureFactory<Code, undefined> &
  ((data?: undefined, options?: FailureOptions) => Failure<Code, undefined>);
/** `define()` overload for failures whose message is derived from their payload. */
export function define<Code extends string, Data>(
  code: Code,
  message: (data: Data) => string,
  defineOptions?: DefineOptions<Data>,
): FailureFactory<Code, Data>;
/**
 * Declares a failure kind once and returns its constructor.
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * const FileMissing = Failure.define('FileMissing', (d: { path: string }) => `no such file: ${d.path}`);
 * const someCaughtValue: unknown = FileMissing({ path: 'a.ts' });
 *
 * FileMissing({ path: 'a.ts' }); // Failure<'FileMissing', { path: string }>
 * FileMissing.is(someCaughtValue); // type guard, cross-realm safe — true
 * FileMissing.code; // 'FileMissing'
 * ```
 *
 * The message is a *function of the payload* rather than a pre-interpolated string so that
 * the structured `data` and the human sentence can never disagree, and so nothing has to be
 * formatted for failures that end up handled silently.
 *
 * The optional third argument declares tracing behavior for the kind — see
 * {@link DefineOptions} and {@link attributes}:
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * const AuthFailed = Failure.define(
 *   'AuthFailed',
 *   (d: { status: number; password: string }) => `auth rejected: HTTP ${d.status}`,
 *   { trace: (d) => ({ 'auth.status': d.status }) }, // the allowlist — password stays private
 * );
 * Failure.attributes(AuthFailed({ status: 401, password: 'hunter2' }));
 * // { 'failure.code': 'AuthFailed', 'auth.status': 401 }
 * ```
 */
export function define<Code extends string, Data>(
  code: Code,
  message: string | ((data: Data) => string),
  defineOptions?: DefineOptions<Data>,
): FailureFactory<Code, Data> {
  if (defineOptions?.trace)
    traceMappers.set(code, defineOptions.trace as (data: unknown) => TraceAttributes);
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
    if (!options?.stackless) Error.captureStackTrace(failure, options?.stackAnchor ?? factory);
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
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * const work = async (): Promise<void> => {};
 * const report = (code: string, data: unknown): void => console.debug(code, data);
 *
 * try {
 *   await work();
 * } catch (error) {
 *   if (!Failure.is(error)) throw error; // a bug keeps flying
 *   report(error.code, error.data); // a declared failure gets handled
 * }
 * ```
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
 * True for a factory made by {@link define}. A factory carries the `code` it produces and its
 * own `is` guard; a plain error-mapper carries neither, so an API can accept both in one
 * position and tell them apart exactly, without guessing from arity.
 *
 * ```ts
 * const NotFound = define('NotFound', 'missing');
 * isFactory(NotFound); // true
 * isFactory((error: unknown) => from(error)); // false — a mapper, not a factory
 * ```
 */
export function isFactory(value: unknown): value is FailureFactory<string, never> {
  return (
    typeof value === 'function' &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { is?: unknown }).is === 'function'
  );
}

/**
 * Narrows a Failure to one of several codes — the multi-code sibling of `Factory.is`.
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * const FileMissing = Failure.define('FileMissing', (d: { path: string }) => `no ${d.path}`);
 * const error: unknown = FileMissing({ path: 'a.ts' });
 *
 * if (Failure.hasCode(error, 'FileMissing', 'PermissionDenied')) error.code; // narrowed union
 * Failure.hasCode(error, 'FileMissing', 'PermissionDenied'); // true
 * Failure.hasCode(Failure.from(new Error('EACCES')), 'FileMissing'); // false — code is 'Unknown'
 * ```
 */
export function hasCode<const Codes extends readonly string[]>(
  value: unknown,
  ...codes: Codes
): value is Failure<Codes[number], unknown> {
  return isFailure(value) && (codes as readonly string[]).includes(value.code);
}

// ── Normalizing arbitrary throwables ─────────────────────────────────────────

/**
 * The failure `from()` produces for a throwable that is not already a Failure.
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * Failure.Unknown.is(Failure.from('nope')); // true — and the original string is preserved under `.cause`
 * ```
 */
export const Unknown: FailureFactory<'Unknown', { thrown: unknown }> = define(
  'Unknown',
  (data: { thrown: unknown }) =>
    data.thrown instanceof Error ? data.thrown.message : `non-Error thrown: ${label(data.thrown)}`,
);

/**
 * Coerces any caught value into a Failure, leaving existing Failures untouched.
 *
 * Necessary because `throw` accepts every value in JS — `throw 'nope'`, `throw undefined`,
 * `throw { code: 42 }` are all legal and all occur in the wild (DOM callbacks, old libraries,
 * and any `Promise.reject(someNonError)`). The original is preserved under `cause` rather
 * than being flattened into a string, so nothing is lost on the way through.
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * const FileMissing = Failure.define('FileMissing', (d: { path: string }) => `no such file: ${d.path}`);
 *
 * Failure.from(FileMissing({ path: 'a.ts' })); // the same Failure, untouched
 * Failure.from(new RangeError('x')); // Failure(Unknown) with the RangeError as `.cause`
 * Failure.from('nope'); // Failure(Unknown) — even a thrown string survives
 * ```
 */
export function from(thrown: unknown): Any {
  if (isFailure(thrown)) return thrown;
  return Unknown({ thrown }, { cause: thrown });
}

// ── Deliberate non-handling ──────────────────────────────────────────────────

// `process` is reached through globalThis so this module also loads in browsers, where the
// object is absent: the env default is simply off there, and setDebug()/onIgnored() remain
// the portable switches.
const NODE_PROCESS = (
  globalThis as {
    process?: {
      env?: Record<string, string | undefined>;
      stderr?: { write(chunk: string): void };
      getBuiltinModule?: (id: string) => unknown;
    };
  }
).process;

// The standard observability seam on server runtimes: every ignored failure also publishes
// `{ context, error }` to the Node/Deno diagnostics_channel below, so any number of
// subscribers (an APM agent, an OpenTelemetry bridge, a test) can listen without this module
// owning a multi-observer registry. `process.getBuiltinModule` is the one builtin access that
// neither crashes a browser nor drags a `node:` import into browser bundles — there the chain
// yields `undefined` and publishing is skipped.
/**
 * Name of the diagnostics_channel that {@link ignore} publishes to on Node and Deno —
 * subscribe with the platform API, no qunitx registry involved. Messages are
 * `{ context: string, error: unknown }`. Browsers have no channel; use {@link onIgnored}.
 *
 * ```ts
 * import * as Failure from './failure.ts';
 * import diagnostics_channel from 'node:diagnostics_channel';
 *
 * const seen: unknown[] = [];
 * const collect = (message: unknown) => seen.push(message);
 * diagnostics_channel.subscribe(Failure.IGNORED_CHANNEL_NAME, collect);
 * await Promise.reject(new Error('boom')).catch(Failure.ignore('cleanup'));
 * seen; // [{ context: 'cleanup', error: Error('boom') }]
 * diagnostics_channel.unsubscribe(Failure.IGNORED_CHANNEL_NAME, collect);
 * ```
 */
export const IGNORED_CHANNEL_NAME = 'qunitx.failure.ignored';
const DIAGNOSTICS = NODE_PROCESS?.getBuiltinModule?.('node:diagnostics_channel') as
  typeof import('node:diagnostics_channel') | undefined;
const ignoredChannel = DIAGNOSTICS?.channel(IGNORED_CHANNEL_NAME);

// Debug output defaults to QUNITX_DEBUG, read once at import; `Config.setup()` calls
// `setDebug(true)` when the --debug flag is set, so both switches reveal the same output.
// The ignore() call sites are in cleanup paths that run with no config in scope (temp-dir
// removal, socket teardown), so threading `config.debug` to them is not an option. Mutable,
// because an env var read at import time cannot be flipped from userland — `setDebug()` below
// is the runtime seam a host application (or a standalone packaging of this module) needs.
let DEBUG = Boolean(NODE_PROCESS?.env?.QUNITX_DEBUG);

/**
 * Toggles ignored-failure reporting at runtime, overriding the `QUNITX_DEBUG` default.
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * Failure.setDebug(true); // every Failure.ignore() label now reports on stderr as it fires
 * Failure.setDebug(false); // back to silent
 * ```
 */
export function setDebug(enabled: boolean): void {
  DEBUG = enabled;
}

/**
 * The callback shape {@link onIgnored} installs: every ignored failure arrives with the
 * label its call site declared.
 */
export type IgnoredObserver = (context: string, error: unknown) => void;
let ignoredObserver: IgnoredObserver | null = null;

/**
 * Installs a process-wide observer for every ignored failure — the interception seam for
 * "list everything the program decided not to handle". Costs one null check on the failure
 * path only (nothing on success, nothing per Task), and retains nothing itself: whether the
 * suppressed failures accumulate, sample, or stream somewhere is the observer's decision.
 * Pass `null` to detach.
 *
 * This is the *portable* hook (it works in browsers) and it holds one observer. On Node and
 * Deno the same events also publish to the {@link IGNORED_CHANNEL_NAME} diagnostics_channel,
 * which takes any number of platform-level subscribers — prefer it for APM/tracing agents.
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * const suppressed: { context: string; error: unknown }[] = [];
 * Failure.onIgnored((context, error) => suppressed.push({ context, error }));
 * // … exercise the program, then: console.table(suppressed)
 * Failure.onIgnored(null); // detach
 * ```
 */
export function onIgnored(observer: IgnoredObserver | null): void {
  ignoredObserver = observer;
}

/**
 * Builds a `.catch()` handler for a failure that genuinely has no consequence — but says so
 * under `QUNITX_DEBUG` instead of vanishing. This is the raw handler; the ergonomic spelling
 * at call sites is `Task(promise).ignore(context)`, which wraps exactly this function.
 *
 * This is the counterpart to `Result`, not a lesser version of it. A `Result` is for a failure
 * the caller branches on; unlinking a temp directory that is already gone is not that, and
 * wrapping it would add ceremony while removing nothing (see the "when not to use this"
 * section of `docs/error-handling.md`).
 *
 * What it does fix is that one `.catch(() => {})` is indistinguishable from any other.
 * A real `EACCES` on a directory qunitx is trying to clean up, and a benign `ENOENT` because
 * it was already cleaned up, currently produce identical silence — inside code whose entire
 * job is diagnosing why a directory will not delete.
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * import { unlink } from 'node:fs/promises';
 * const socketPath = '/tmp/qunitx-daemon.sock';
 *
 * await unlink(socketPath).catch(Failure.ignore('daemon socket unlink')); // even a denied unlink is fine
 * ```
 */
export function ignore(context: string): (error: unknown) => void {
  return (error: unknown) => {
    ignoredObserver?.(context, error);
    // hasSubscribers first so the quiet path allocates no message object.
    if (ignoredChannel?.hasSubscribers) ignoredChannel.publish({ context, error });
    if (!DEBUG) return;
    // stderr, not stdout: stdout is the TAP stream and a stray line there corrupts the report.
    const line = `# [qunitx] ignored (${context}): ${format(error)}`;
    if (NODE_PROCESS?.stderr) NODE_PROCESS.stderr.write(`${line}\n`);
    else console.error(line);
  };
}

// ── Tracing — the observation seam ───────────────────────────────────────────
//
// The counterpart to the ignore seam above, for failures that ARE handled: whenever a Task
// classifies a rejection as a declared Failure and hands it to the caller (`result()`,
// `match`, `unwrapOr`, `recover`), it reports here. A tracing adapter subscribes once and
// annotates the active span — application code never writes `span.recordException` by hand,
// and the abstractions never import a tracer. Bugs never pass through this seam: they keep
// rejecting toward the crash boundary, so the two tiers stay separate in traces too.

/**
 * Name of the diagnostics_channel that {@link observed} publishes to on Node and Deno.
 * Messages are `{ error: Failure.Any }`. This is what a tracing adapter subscribes to —
 * e.g. OpenTelemetry, in its entirety:
 *
 * ```ts
 * import * as Failure from './failure.ts';
 * import diagnostics_channel from 'node:diagnostics_channel';
 *
 * // Defined, not invoked: the adapter an application imports once at boot.
 * function installOtelAdapter(getActiveSpan: () => { recordException(e: Error): void; setAttributes(a: object): void } | undefined) {
 *   diagnostics_channel.subscribe(Failure.OBSERVED_CHANNEL_NAME, (message) => {
 *     const { error } = message as { error: Failure.Any };
 *     const span = getActiveSpan(); // resolves via AsyncLocalStorage — the right span, free
 *     span?.recordException(error);
 *     span?.setAttributes(Failure.attributes(error));
 *   });
 * }
 * ```
 */
export const OBSERVED_CHANNEL_NAME = 'qunitx.failure.observed';
const observedChannel = DIAGNOSTICS?.channel(OBSERVED_CHANNEL_NAME);

/**
 * The callback shape {@link onObserved} installs: every declared failure a consumer
 * classified arrives right as it is handed to application code.
 */
export type ObservedObserver = (failure: Any) => void;
let observedObserver: ObservedObserver | null = null;

/**
 * Installs a process-wide observer for every *handled* declared failure — the portable
 * (browser-friendly) counterpart of subscribing to {@link OBSERVED_CHANNEL_NAME}. Single
 * slot, one null check on the failure path, nothing retained; pass `null` to detach.
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * const handled: string[] = [];
 * Failure.onObserved((failure) => handled.push(failure.code));
 * // … Task consumers (`result()`, `match`, `unwrapOr`, `recover`) report here as they classify
 * Failure.onObserved(null); // detach
 * ```
 */
export function onObserved(observer: ObservedObserver | null): void {
  observedObserver = observer;
}

/**
 * Reports a declared failure to the observation seam — {@link onObserved} plus the
 * {@link OBSERVED_CHANNEL_NAME} channel. Task's consuming methods call this at their
 * classification points; call it yourself only for a *synchronous* `Result` flow that never
 * crossed a Task, so a tracing adapter sees those failures too.
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * const Invalid = Failure.define('Invalid', (d: { field: string }) => `bad ${d.field}`);
 * const failure = Invalid({ field: 'email' });
 * Failure.observed(failure); // hand-reported: a sync Result branch a tracer should still see
 * ```
 */
export function observed(failure: Any): void {
  observedObserver?.(failure);
  // hasSubscribers first so the quiet path allocates no message object.
  if (observedChannel?.hasSubscribers) observedChannel.publish({ error: failure });
}

/**
 * Span/log attributes a failure declares for tracing: `failure.code` plus whatever its
 * factory's `trace` mapper (see {@link define}) explicitly allowlisted from `data`. A
 * failure whose factory declared no mapper yields the code alone — **unmapped payload
 * fields never leave the process**, which is what makes redaction (passwords, tokens) the
 * default rather than a discipline.
 *
 * Keyed by `code`, so it also works on failures that crossed a realm or a `fromJSON` revive.
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * const AuthFailed = Failure.define(
 *   'AuthFailed',
 *   (d: { status: number; password: string }) => `auth rejected: HTTP ${d.status}`,
 *   { trace: (d) => ({ 'auth.status': d.status }) },
 * );
 *
 * Failure.attributes(AuthFailed({ status: 401, password: 'hunter2' }));
 * // { 'failure.code': 'AuthFailed', 'auth.status': 401 } — the password cannot leak: never mapped
 * ```
 */
export function attributes(failure: Any): TraceAttributes {
  const mapper = traceMappers.get(failure.code);
  return { 'failure.code': failure.code, ...mapper?.(failure.data) };
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
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * const FileMissing = Failure.define('FileMissing', (d: { path: string }) => `no such file: ${d.path}`);
 *
 * const root = new Error('EACCES');
 * const wrapped = FileMissing({ path: 'a.ts' }, { cause: root });
 * Failure.causes(wrapped); // [wrapped, root]
 * ```
 */
export function causes(error: unknown): unknown[] {
  // The chain doubles as the seen-set: identity `includes` over ≤32 entries measured 2–3×
  // faster than the dedicated Set this used to keep (the Set allocation dominated), and a
  // recursive persistent-accumulator variant measured ~2× slower at the depth bound.
  const chain: unknown[] = [];
  for (
    let link = error;
    link != null && chain.length < MAX_CAUSE_DEPTH && !chain.includes(link);
    link = (link as { cause?: unknown }).cause
  ) {
    chain.push(link);
  }
  return chain;
}

/**
 * The deepest `cause` in the chain — the original failure, whatever wrapped it since.
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * const FileMissing = Failure.define('FileMissing', (d: { path: string }) => `no such file: ${d.path}`);
 * const root = new Error('EACCES');
 * const wrapped = FileMissing({ path: 'a.ts' }, { cause: root });
 *
 * Failure.rootCause(wrapped) === root; // true, however many layers wrapped it on the way up
 * ```
 */
export function rootCause(error: unknown): unknown {
  return causes(error).at(-1);
}

/**
 * Renders an error and its whole `cause` chain as indented, human-readable lines.
 *
 * Node's own `util.inspect` renders `cause` chains well, but only for real `Error` objects
 * and only when something calls it — this works on revived wire failures too, and is what
 * you want in a TAP comment or a CLI's stderr block where a full stack would be noise.
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * const GitScanFailed = Failure.define('GitScanFailed', (d: { ref: string }) => `bad ref: ${d.ref}`);
 * const failure = GitScanFailed({ ref: 'HEAD' }, { cause: new Error('spawn git ENOENT') });
 *
 * Failure.format(failure);
 * // GitScanFailed: bad ref: HEAD
 * //   caused by: Error: spawn git ENOENT
 * Failure.format(failure, { stacks: true }); // same, with indented frames under each link
 * ```
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
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * const ws = { send(_data: string) {} }; // stands in for the run's WebSocket
 * const failure = Failure.from(new Error('boom'));
 *
 * ws.send(JSON.stringify({ event: 'run-error', error: Failure.toJSON(failure) }));
 * ```
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
 *
 * ```ts
 * import * as Failure from './failure.ts';
 *
 * const GitScanFailed = Failure.define('GitScanFailed', (d: { ref: string }) => `bad ref: ${d.ref}`);
 * const frame = JSON.stringify({ error: Failure.toJSON(GitScanFailed({ ref: 'HEAD' })) });
 *
 * const { error } = JSON.parse(frame);
 * const failure = Failure.fromJSON(error); // a real Failure again
 * GitScanFailed.is(failure); // factory guards work on revived failures too — true
 * ```
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
