# Error handling: bugs throw, failures return

A general-purpose error system for JS/TS, in three small modules with no dependencies.

| module                                      | role                                                        |
| ------------------------------------------- | ----------------------------------------------------------- |
| [`lib/result/result.ts`](../lib/result/result.ts)    | the **value** — `Result<T, E>`, a bare union         |
| [`lib/result/failure.ts`](../lib/result/failure.ts)  | the **taxonomy** — declared, serializable failures   |
| [`lib/result/try.ts`](../lib/result/try.ts)          | the **boundary** — where a `throw` becomes a value   |
| [`lib/task/task.ts`](../lib/task/task.ts)            | the **async half** — a lazy, retryable, typed Promise |

Tests: [`test/result/`](../test/result/), [`test/task/`](../test/task/). A runnable end-to-end
example lives in [`examples/error-handling-server.ts`](../examples/error-handling-server.ts).

---

## The one rule

> **Bugs throw. Expected failures return.**

A **bug** is a state you did not intend and cannot handle here: `undefined is not a function`,
a violated invariant, a typo'd property. There is no correct local response. It should
propagate loudly, keep its stack, and crash something small.

An **expected failure** is a documented outcome of a *correct* program: the file was not there,
the port was taken, the token expired. The caller has a plan. It should be a **value**, in the
signature, that the type system makes you address.

```ts
// expected failure — a value, in the return type
function parsePort(raw: string): Result<number, InvalidPortFailure> {
  return /^\d+$/.test(raw) ? Number(raw) : InvalidPort({ raw });
}

// bug — a throw, no signature, no handler
if (state === undefined) throw new Error('unreachable: state machine desynced');
```

This is Lua's `nil, err` versus `error()`, with `pcall` as the boundary between them. Go split
it into `error` and `panic`, Zig into error unions and `unreachable`, Swift into `throws` and
`fatalError`, Rust into `Result` and `panic!`.

**The most common mistake in JS error handling is collapsing the two tiers into one** — which is
what a bare `try/catch` does by default, and what every `Result.fromThrowable`-style helper does
too. Catching everything is *worse than no error handling* for the bug case: without a `catch`, a
`TypeError` produces a stack trace pointing at the broken line; with one, it becomes a tidy
failure value flowing down the same path as a legitimate outcome — and it ships.

---

## Quick start

```ts
import * as Result from './lib/result/index.ts';
import { Task } from './lib/task/index.ts';

const { Failure } = Result;

// 1. Declare what can fail. The message is derived from the payload, never parsed back out.
const PortTaken = Failure.define('PortTaken', (d: { port: number }) => `port ${d.port} is busy`);
type PortTakenFailure = Failure.Of<typeof PortTaken>;

// 2. Produce it. Return the value or return the failure — no wrapper on either arm.
function bind(port: number): Result.Result<Server, PortTakenFailure> {
  return isFree(port) ? listen(port) : PortTaken({ port });
}

// 3. Consume it. One guard, both branches narrowed.
const server = bind(8080);
if (Failure.is(server)) console.error(Failure.format(server)); // PortTakenFailure here
else server.close(); //                                          Server here

// 4. Async: a Task carries the failure type through the whole chain.
const outcome = await Task(() => runGit(ref))
  .mapErr((cause) => GitScanFailed({ ref }, { cause })) // foreign errors classified once
  .map(parse) //                                          a bug in parse stays a bug
  .result(); // ChangeScan | GitScanFailure — a bare union
```

There is no `Ok()`, no `Err()`, and no `.unwrap()` on the happy path. **The value is itself and
the failure is itself**; `Failure.is()` is the only discriminant.

---

## `Result<T, E>` — the value

```ts
export type Result<T, E = Failure.Any> = T | E;
```

A bare union: no box, no allocation per outcome, nothing wrapped around the value. `E` should
always be a `Failure` type, because the brand is the only discriminant.

### Leaving the Result world

| call                          | returns           | on a failure                                    |
| ----------------------------- | ----------------- | ----------------------------------------------- |
| `Result.unwrap(outcome)`      | the value         | throws it **by identity** — original stack kept  |
| `Result.expect(outcome, msg)` | the value         | throws `Error(msg)` with the failure as `cause`  |
| `Result.unwrapOr(outcome, x)` | the value, or `x` | returns the fallback                            |

`unwrap` when you want the failure's own stack (debugging); `expect` when you want to record
*this* site as the one that could not continue.

```ts
const flags = Result.unwrap(Args.parse(projectRoot)); // ≡ if (Failure.is(f)) throw f;
```

### Batches

```ts
Result.all(outcomes); //       T[] — or the FIRST failure, by index (deterministic)
Result.partition(outcomes); // { values: T[], errors: E[] } — keeps both
```

`partition` is the shape most batch work actually wants and the one `Promise.all` cannot give
you: a rejected `Promise.all` discards the settled successes along with the other failures.

### Propagating

A failure is **born** exactly once, at the factory call. Everywhere it merely travels, the
spelling is a bare pass-through — nothing to open, nothing to re-seal:

```ts
const failed = applyFlag(flags, token.raw); // ParseFailure | undefined
if (failed) return failed; // hand the SAME failure up, allocation-free
```

This typechecks against *any* caller's Result, because a `Failure` is a union arm rather than a
container bound to one success type: the same `ParseFailure` serves a function that succeeds
with `undefined` and one that succeeds with `ParsedFlags`. It is Go's `if err != nil { return
err }` without the ceremony. In async code the line disappears entirely — a `Task` failure is a
rejection, and rejections propagate themselves.

---

## `Failure` — the taxonomy

```ts
const FileMissing = Failure.define('FileMissing', (d: { path: string }) => `no such file: ${d.path}`);

const f = FileMissing({ path: 'a.ts' }, { cause: errno });
f.code; //    'FileMissing' — the discriminant, a string
f.data; //    { path: 'a.ts' } — structured and typed
f.message; // 'no such file: a.ts' — derived, never parsed back
f.cause; //   the original, chained
```

A `Failure` **extends `Error`**, so `util.inspect`, devtools stack expansion,
`unhandledRejection` reporting and every logger's error branch keep working.

| API                                    | purpose                                                        |
| -------------------------------------- | -------------------------------------------------------------- |
| `Failure.define(code, message, opts?)` | declare a factory; `message` is a string or `(data) => string`  |
| `Failure.Of<typeof Factory>`           | the type a factory produces                                     |
| `Failure.is(value)`                    | the guard — narrows both branches                              |
| `FileMissing.is(value)`                | the same, *and* matches the specific `code`                     |
| `Failure.hasCode(value, 'X')`          | guard and discriminate in one step                              |
| `Failure.format(f)`                    | human-readable, including the `cause` chain                     |
| `Failure.causes(f)` / `rootCause(f)`   | walk the chain — cycle-safe and depth-bounded                   |
| `Failure.toJSON(f)` / `fromJSON(json)` | cross a socket, a worker, a process                             |
| `Failure.from(unknown)`                | the adapter edge — anything becomes a Failure                   |
| `Failure.ignore(context)`              | a **labelled** swallow, observable under `--debug`              |

### Discriminate on `code`, never `instanceof`

`instanceof` is realm-scoped. An iframe, a `Worker`, a `vm` context and a `MessageChannel` peer
each have their own `Error` binding, so an error built in one and tested in another fails the
check while being the same error in every sense that matters. That is not exotic here: qunitx
runs tests **inside a browser page** and ships failures to Node over a WebSocket, so every error
crossing that link is cross-realm by construction *and* JSON-serialized, which destroys the
prototype anyway.

```ts
const revived = JSON.parse(frame); // { failure: true, code: 'PortTaken', … }
Failure.is(revived); //      true  ✅
revived instanceof Error; // false ❌
```

In-process, `Failure.is` tests `Symbol.for('result.Failure')` — the global symbol registry is
per **process**, not per realm, so the same key resolves inside a Worker. On the wire the brand
degrades to a structural marker (`failure: true` plus a string `code`), which any JSON producer
could counterfeit; at protocol boundaries prefer the factory guards (`FileMissing.is`) or a
typed envelope. The daemon protocol does the latter, discriminating every frame on an explicit
`type` field rather than asking the payload what it is.

### The two observability seams

Suppressed and handled failures each get a `diagnostics_channel`, so an APM agent subscribes
once instead of every call site writing telemetry:

```ts
// suppressed — `ignore(context)` is a labelled swallow, not a silent one
Task(page.close()).ignore('page close during shutdown');
Failure.onIgnored((f, context) => log.debug(context, f)); // or --debug / QUNITX_DEBUG

// handled — every consumer that classifies a declared failure reports it
Failure.onObserved((f) => span.setAttributes(Failure.attributes(f)));
```

`Failure.attributes` derives span attributes from an **allowlist** the kind declares, so a
payload field the mapper does not return cannot reach a span — redaction is the default rather
than a discipline:

```ts
const Denied = Failure.define('Denied', (d: { user: string; token: string }) => `denied ${d.user}`, {
  trace: (d) => ({ 'app.user': d.user }), // `token` can never be traced
});
```

Bugs never pass either seam; they keep rejecting toward the crash boundary, so the two tiers
stay separate in traces too. The module reaches `diagnostics_channel` through
`process.getBuiltinModule`, so no `node:` import lands in a browser bundle.

---

## The boundary — where a `throw` becomes a value

This is the **only** place a box appears, and for a precise reason: a `catch` binding is
`unknown`, so it carries no brand to discriminate on.

```ts
const parsed = Result.try(() => JSON.parse(raw)); // Caught<unknown, unknown>
if (parsed.ok) use(parsed.value);
else console.error(parsed.error);
```

`Result.try(fn, ...args)` mirrors `Promise.try`: sync-in/sync-out, async-in/async-out — it never
turns a synchronous call into a promise — and because it owns the *call*, it also covers the
synchronous prefix of an async function, which a trailing `.catch()` does not.

### The declaration is a flat line at the call site

This is the core discipline, and the thing no other tool does:

```ts
const parsed = Result.try(JSON.parse, raw);
if (!parsed.ok && !(parsed.error instanceof SyntaxError)) throw parsed.error;
```

A `SyntaxError` is an outcome the next line may branch on. A `TypeError: Cannot read properties
of undefined` is a bug, and **the rethrow line puts it back in the air**, with its stack pointing
at the broken line. Keep the boundary around exactly the fallible call:

```ts
// bad — the catch also covers `render`, so a bug in render is reported as "network failed"
try {
  return render(await fetchUser(id));
} catch {
  return fallback;
}

// good — the boundary is the call, the declaration is visible, and a bug in render throws
const user = await Result.try(fetchUser, id);
if (!user.ok && !NetworkError.is(user.error)) throw user.error;
if (!user.ok) return fallback;
return render(user.value);
```

`grep "throw .*\.error"` finds every declaration in the codebase.

When *every* throw at a boundary means one declared thing, `rescue` fuses the two steps and
hands back a bare union instead of a box:

```ts
const config = await Result.rescue(
  () => readConfig(path),
  (cause) => ConfigUnreadable({ path }, { cause }),
);
```

`Result.isErrno(value, 'ENOENT')` is the matching guard for Node system errors, which are the
most common thing found in a `catch` here.

---

## `Task<T, E>` — the async half

A real Promise (`instanceof Promise` holds; the official Promises/A+ suite passes 872/872) built
from a **lazy recipe**, callable with or without `new`.

```ts
export function scanChanges(root: string, ref: string): Task<ChangeScan, GitScanFailure> {
  return Task(() => Promise.all([runGit(root, ref), runGit(root, 'HEAD')]))
    .mapErr((cause) => GitScanFailed({ ref }, { cause }))
    .map(parse);
}

await scanChanges('.', 'HEAD'); //          the value, or REJECTS with the failure
await scanChanges('.', 'HEAD').result(); // the bare union — never rejects on a declared failure
```

- **Lazy and memoised.** The recipe runs on first `await`; every derivation shares one run.
  `perform()` starts it *now* without suspending, so it can overlap other work.
- **Lineage.** Each derivation records its source, so `retry()` and `restart()` re-run the
  *whole chain* — `scan.map(parse).context(msg).retry()` re-runs the git calls, not just the parse.

| method                          | does                                                                   |
| ------------------------------- | ---------------------------------------------------------------------- |
| `.map(fn)`                      | transform the value; a throw inside stays a bug                        |
| `.mapErr(fn \| Factory, data?)` | **the adapter edge** — classify anything foreign, once                 |
| `.ensure(pred, Factory)`        | an invariant *on the success value* — wrong-but-resolved fails by name  |
| `.orElse(fn)`                   | Rust's `or_else` — a second chance that may itself fail (`E` → `F`)     |
| `.recover(fn)`                  | the crash boundary — promises none remains (`E` → `never`)              |
| `.context(message)`             | anyhow's context: same `code`/`data`, message added, original as `cause` |
| `.retry(times, opts)`           | re-run the chain; `{ when }` is tokio's `retry_if`, plus delay/backoff  |
| `.finally(fn)`                  | cleanup that keeps the chain a **Task**, not a plain Promise            |
| `.ignore(context)`              | the one **eager** method — labelled, with no unhandled-rejection window |
| `.result()`                     | settle to the bare `T \| E` union                                       |
| `.match({ ok, err })`           | branch on both arms                                                    |
| `.unwrapOr(fallback)`           | the value, or the fallback                                             |
| `.await(ms)` / `.yield(ms)` / `.shutdown(ms)` | Elixir's `Task.await` / `yield` / `shutdown`             |

**The two-tier rule threads through every consumer.** `result()`, `match`, `unwrapOr`, `orElse`
and `ensure` act on *declared* failures and **rethrow bugs**. `mapErr` and `recover` are the two
deliberate catch-alls, named so a reviewer can see them.

```ts
// `orElse` vs `recover` — the difference is the return type, and that is the whole point
task.orElse((e) => tryReplica(e)); // Task<T, ReplicaFailure> — still fallible, still declared
task.recover(() => null); //          Task<T | null, never>   — nothing declared remains
```

**Prefer naming a failure at its condition** over a trailing `mapErr`, when the function can name
it itself. A trailing `mapErr` sees *every* rejection, so an unrelated `EACCES` would be reported
as your failure:

```ts
return Task(async () => {
  const found = await searchParents(cwd, 'package.json');
  if (!found) throw ProjectRootNotFound({ cwd }); // named where it is known
  return path.dirname(found);
});
```

### Combinators

`all` / `race` / `any` / `allSettled` / `withResolvers` are overridden — the inherited ones
construct through `new this(executor)`, which a recipe constructor cannot honour — and made
**lazy**: nothing in the iterable is observed until the combined Task is awaited. `Task.all`
preserves the members' declared `E` rather than widening it.

```ts
const [tree, plugins] = await Task.all([FSTree.build(paths, config), resolvePlugins(raw, root)]);

const outcomes = await Task.results(paths.map(load)); // (T | E)[] — feeds Result.partition
```

Every instance method has a **data-first static twin** — `Task.map(task, fn)` ≡ `task.map(fn)` —
Elixir-style module functions, each pair sharing one doc surface and covered by a twin-law test.

---

## Recipes

**Degrade instead of failing.**

```ts
const scan = await scanChanges(root, ref).result();
if (Failure.is(scan)) return runEverything(); // a failed git scan is not a failed run
```

**Keep a cache miss out of the taxonomy.** A miss is the *absence* of a failure, so there is
nothing to declare and nothing for a caller to discriminate:

```ts
return Task(() => fs.readFile(path, 'utf8'))
  .map((raw) => {
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  })
  .recover(() => null); // absent, unreadable, torn or stale — one answer
```

**Clean up with explicit resource management** rather than `finally` ladders. A cleanup
registered with `using` cannot be stranded by an early return or a failing assertion:

```ts
await using output = outputDir('coverage'); // removed when the scope ends, however it ends
await shell(`node cli.ts … --output=${output}`);
```

**Map codes to a transport at the edge, never on the failure.** The same `FileMissing` is 404
over HTTP, exit code 1 over a CLI, `NOT_FOUND` over gRPC and a retry over a queue:

```ts
const STATUS: Record<string, number> = { FileMissing: 404, Invalid: 422, Denied: 403 };
res.status(STATUS[failure.code] ?? 500).json(Failure.toJSON(failure));
```

---

## Design decisions

**Why a bare union rather than `{ ok, value, error }`.** A class instance does not survive a
boundary — `structuredClone`, `postMessage`, `IndexedDB` and `JSON` all copy own enumerable
properties and discard the prototype, so the data arrives and the methods do not. A plain-data
box survives, but it is a second vocabulary: a `Failure` is already a first-class element, so
`Task.results`, `Result.partition`, `Result.all` and the wire format all speak the union.
Boxing the Task boundary would mean translating at every one of them, allocating a wrapper per
outcome in a stream, nesting matryoshka-style, and re-boxing after every network hop. And
because `Failure.is` *narrows*, control flow hands you the value with no `.value` access at all.

**The honest cost.** The box carried channel identity in the **envelope** — `.ok` was
authoritative whatever `T` was. The union infers it from the **payload**, which is sound exactly
as long as one precondition holds: **`T` must never itself be, or contain bare, a `Failure`.**
TypeScript cannot enforce this — there are no negated types — so it is a convention held by
review, and `test/result/result-test.ts` pins the failure mode so it stays visible.

Concrete code with concrete types always knows its `T`. **Generic middleware is where it bites**,
because retry/cache/memoize/queue never look at `T`, so the brand check is the only
discrimination available:

```ts
// a legitimate producer whose VALUE is a fetched failure report — qunitx's own domain,
// since the browser ships test failures over the WebSocket and the CLI revives them
const report = withRetry(() => fetchStoredFailureReport(), 3);
// every fetch SUCCEEDED, yet: N non-idempotent calls were made ("retrying" successes),
// and the fetched report came back on the error channel. No error anywhere.
```

The escape is one convention: **failures-as-data never travel bare.** Put them in a container —
`Failure.is([f])` and `Failure.is({ report })` are both `false`:

```ts
function crashReport(): Task<{ crashes: Failure.Any[] }, never> {} // fine
function crashReport(): Task<Failure.Any, never> {} //               ambiguous — don't
```

**Why not a `[value, error]` tuple.** It is positional, so it is memorised — `await-to-js`
returns `[err, data]` and other libraries return `[data, err]`, and nothing catches a swap where
the types are compatible. `T | null` also collides with the sentinel: if `T` can legitimately be
`null`, `[null, null]` is ambiguous. The union has no sentinel to collide with, and it narrows
across function boundaries, in `filter` callbacks, and on values revived from JSON, because the
discriminant travels *inside* the failure rather than in a container positioned around it.

**Why there are no `Result` combinators.** A bare value has nothing to hang methods on, so
`map`/`andThen` could only be free functions, and free-function composition reads inside-out:
`andThen(map(parse(raw), normalize), validate)`. An earlier iteration shipped them; nothing used
them. In a language with `do`-notation, `?` or `try`, chaining is how you avoid pyramids —
JavaScript already has what chaining substitutes for, which is early return. Where a pipeline is
*not* settled yet, the value is not there to `if` on, and that is exactly where chaining earns
its keep: it lives on `Task`, the producer, which may be a class because it never crosses a wire.

---

## Corner cases

- **Anything can be thrown**, including `undefined` — most often as `Promise.reject(nonError)`
  from DOM and legacy callbacks. `Failure.from` normalises any of them, keeping the original
  under `cause`. At the boundary a caught `undefined` is still a failure, because `Caught`'s
  `ok` flag is the discriminant rather than truthiness.
- **`JSON.stringify(new Error('boom'))` is `{}`** — `message` and `stack` are own-but-non-enumerable
  and `name` is on the prototype. `Failure` has a `toJSON`, so `JSON.stringify(failure)` works;
  use `Failure.toJSON(anyError)` for everything else.
- **`structuredClone` drops custom Error properties**, which is why the wire format is an explicit
  `toJSON`/`fromJSON` pair rather than a raw clone.
- **A revived stack is the *remote* stack.** It is kept, and labelled as such.
- **A Node system error is not a Failure.** `isErrno(value, 'ENOENT')` is the guard for those.
- **`cause` chains can cycle.** `causes()` and `format()` are cycle-safe and depth-bounded.
- **`finally` can swallow an in-flight exception** if it returns or throws. `Task#finally` follows
  the spec exactly: the callback takes no arguments, its return value is discarded, and only a
  *throw* replaces the outcome.
- **Cleanup errors mask the original.** `AsyncDisposableStack` raises `SuppressedError`, keeping both.
- **Cancellation is not a failure.** An aborted operation did not fail; it was not wanted.
  `shutdown()` reports what had landed rather than inventing an error.
- **Exhaustiveness** over `code` is a plain `switch` with a `never` default — no library needed.
- **TypeScript still cannot** check that a function only throws what it declares. The discipline
  comes from the boundary being explicit, not from the compiler.

---

## Performance

Node 24.16.0, x86-64 Linux, 1M iterations after warmup.

|                                | ns/op |
| ------------------------------ | ----- |
| return the value directly      | 71.6  |
| `try`/`catch` around a success | 65.7  |
| `Result.try(fn)` on a success  | 60.8  |

All within noise of one another. The first row *is* the union's happy path — a bare return with
no allocation per outcome, indistinguishable from code with no error handling, because on the
success path that is what it is. `try`/`catch` has not been a deoptimization barrier in V8 since
TurboFan (2017), so any argument for or against this design on happy-path performance grounds is
unfounded.

---

## When not to use this

Most code does not need it. A declared failure earns its line only when a **caller has a plan**
for it. If every call site would do the same thing with the failure, or would only log it, a
throw and one boundary is simpler and shorter.

Reach for it when the failure is part of the contract: a CLI that must exit with a message
instead of a stack, a daemon that must reject one client's bad input and stay up, a library whose
users need to branch on why. Everywhere else, let bugs throw.
