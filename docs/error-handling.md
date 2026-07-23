# A general-purpose error-handling system for JS/TS

Implementation: [`lib/result/`](../lib/result/). Tests: [`test/result/`](../test/result/).

This document argues for a specific design, shows the code, compares it honestly against the
alternatives, catalogues the corner cases, and ends with a tutorial. It also says where the
design is *not* worth adopting, because that turns out to be a large fraction of any codebase.

---

## 1. The problem, measured

An audit of this repository (`lib/` + `test/`, excluding `node_modules`/`dist`/`tmp`) found:

| | count |
|---|---|
| `try`/`catch` blocks | 85 |
| `.catch(…)` handlers | 100 |
| …of which discard the error entirely (`() => {}`, `→ null`, `→ false`, `→ []`, `→ 0`, `→ ''`) | ~67 |
| functions returning `T \| null` where `null` means "it failed" | 39 |
| `process.exit()` call sites | 24 |
| `class X extends Error` | 2 |
| `AbortController` / `AbortSignal` | 0 |

The counts are not the interesting part — most codebases look like this. What is interesting
is *what the shape of the language did to the code*. Five representative sites:

**A catch that cannot tell four failures apart.** `lib/commands/run/tests-in-browser.ts:404`
handles a daemon control-flow signal, an esbuild bundle failure, a `page.goto` navigation
timeout, and anything the test runner threw — in one block. It distinguishes bundle failures
from the rest by duck-typing `(error as { errors?: unknown[] }).errors?.length`, then converts
everything to `new BundleError(error)`. A navigation timeout is therefore reported to the user
as `esbuild Bundle Error: …`, and `BundleError` passes no `cause`, so the original stack and
esbuild's structured `errors[]` are destroyed.

**A category re-derived by regex from a message that already knew it.**
`deriveBuildErrorType()` (`tests-in-browser.ts:92`) runs four regexes over `error.message` to
recover `'Module Resolution Error' | 'Syntax Error' | 'Reference Error' | 'Build Error'`. This
is what a `catch (e: unknown)` forces: the throw site had the category, the type system
provided no channel to carry it, so the catch site reconstructs it from prose.

**A sentinel with two opposite meanings.** `getChangedFilePathsInGitSince()` returns `null` to
mean *"a blast-radius file changed — run everything"* and throws on actual failure. Its caller
(`lib/setup/get-changed-fs-tree.ts:46`) then does
`.catch((err: Error) => err)` and discriminates a `Set<string> | null | Error` union by
`instanceof`. Adjacent branches read `changed === null` (run everything) and
`changed.size === 0` (run nothing). Every branch degrades to "run all", so a genuine bug here
presents as a permanently slow but green suite.

**Nine failures visible only under `--debug`.** `.catch((err) => config.debug && process.stderr.write(…))`
appears at nine sites. A failed cache write is invisible in normal operation.

**A pure function that kills the process.** `lib/args/parse.ts` is an `argv → ParsedFlags`
transform with seven `console.error` + `process.exit(1)` sites in it. It cannot be unit-tested
normally — `test/args/parse-test.ts:622` monkeypatches `process.exit` to throw a `Symbol` — and
the daemon, which parses argv per request, cannot reuse it without dying.

None of these are sloppiness. They are all the shortest correct-looking thing to write given
that **JavaScript has no way to say what a function can fail with**.

---

## 2. The model: two tiers

The design rests on one distinction, and everything else follows from it:

> **Bugs throw. Expected failures return.**

- A **bug** is a state the programmer did not intend and cannot handle: `undefined is not a
  function`, an exhausted invariant, a violated precondition. There is no correct local
  response. It should propagate loudly to a boundary, with a stack trace, and ideally crash
  something small.
- An **expected failure** is a documented outcome of a correct program: the file was not
  there, the port was taken, the input did not validate, the token expired. The caller has a
  plan. It should be a *value*, in the signature, that the type system forces you to address.

This is not a Rust idea. It is exactly what Lua does, and Lua is why the question was asked:

```lua
-- expected failure: a value
local file, err = io.open("config.toml")
if not file then return nil, err end

-- bug: an error
error("unreachable: state machine in an impossible state")

-- boundary: convert one into the other
local ok, result = pcall(risky)
```

`io.open` returns `nil, err` because a missing file is *normal*. `error()` exists for the
other thing. `pcall` is the boundary between them. Go, Zig, Swift and Rust all landed on the
same split (Go: `error` vs `panic`; Zig: error unions vs `unreachable`; Swift: `throws` vs
`fatalError`; Rust: `Result` vs `panic!`).

**The single most common mistake in JS error handling is collapsing these two tiers into one**
— which is what `try { … } catch (e) { … }` does by default, and what every
`Result.fromThrowable`-style helper does too.

---

## 3. The API

Three modules, no dependencies.

```ts
import * as Result from './lib/result/index.ts';
// or: import { ok, err, unwrap, attempt, type Result } from './lib/result/index.ts';
//     ( Result.try is the primary spelling; `attempt` is its bare-importable alias — `try`
//       is a reserved word, so `import { try }` is illegal while `Result.try` is fine. )
```

### `Result<T, E>` — the value

```ts
type Ok<T>  = { readonly ok: true;  readonly value: T; readonly error?: undefined };
type Err<E> = { readonly ok: false; readonly value?: undefined; readonly error: E };
type Result<T, E = unknown> = Ok<T> | Err<E>;
```

```ts
Result.ok(42)            // { ok: true,  value: 42, error: undefined }
Result.err(failure)      // { ok: false, value: undefined, error: failure }

Result.isOk / isErr / isResult
Result.unwrap / expect / unwrapOr / unwrapOrElse / match
Result.map / mapErr / andThen
Result.all / partition
```

### `Failure` — the taxonomy

```ts
const FileMissing = Result.Failure.define(
  'FileMissing',
  (data: { path: string }) => `no such file: ${data.path}`,
);

FileMissing({ path: 'a.ts' });          // Failure<'FileMissing', { path: string }>
FileMissing.is(caught);                 // cross-realm type guard
FileMissing.code;                       // 'FileMissing'
```

A `Failure` is an `Error` subclass carrying a literal `code` discriminant and a typed `data`
payload, plus `cause` chaining, `toJSON`/`fromJSON`, `causes()`, `rootCause()` and `format()`.

`Failure.ignore(context)` is the deliberate opposite — a `.catch()` handler for a failure that
genuinely has no consequence, which says so under `QUNITX_DEBUG` instead of vanishing:

```ts
await unlink(socketPath).catch(ignore('daemon socket unlink'));
```

It is not a lesser `Result`; it is what §10 recommends *instead* of one. The point is that
`.catch(() => {})` cannot be told apart from `.catch(() => {})` — a real `EACCES` on a
directory qunitx is trying to clean up and a benign `ENOENT` because it was already gone
produce identical silence, inside code whose whole job is diagnosing why a directory will not
delete.

### `Result.try` — the boundary

```ts
const parsed = Result.try(() => JSON.parse(raw), { catch: SyntaxError });
//    ^? Result<unknown, SyntaxError>
```

`Result.try` runs a function (or awaits a promise) and converts **declared** failures into
`Err`. Anything not declared is rethrown. Matchers may be an `Error` constructor, a type-guard
predicate (`Result.errno('ENOENT')`), or a `Failure` factory. Omit `catch` (or call
`Result.pcall`) for Lua semantics — catch everything, typed `unknown`.

### `AsyncResult` — the awaitable producer

The sync `Result` is inert plain data, which is load-bearing (§4.1) but costs the awaitable,
left-to-right ergonomics of a promise. `AsyncResult<T, E>` recovers them in the one place it is
safe: on the **producer**, not on the settled value. It is a thenable that **resolves to a plain
`Result`**.

```ts
export function setup(): AsyncResult<Config, ConfigFailure> {
  return Result.from(assemble());   // assemble(): Promise<Result<Config, ConfigFailure>>
}

// A caller that only awaits never needs to know AsyncResult exists — it gets a plain Result:
const r = await setup();
if (!r.ok) return handle(r.error);
use(r.value);

// A caller that wants to transform chains, and still settles to a plain Result:
const port = await setup().map((c) => c.port).andThen(validatePort);
```

Why this is safe where a thenable *value* is not: because an `AsyncResult` resolves to a
non-thenable `Result`, the Promise resolution algorithm's recursive assimilation terminates
there. `Awaited<AsyncResult<T, E>>` is `Result<T, E>`, so `await` hands you the object you branch
on — it never collapses to `Promise<T>` the way a thenable value would (§4.4). An `AsyncResult`
never *rejects* for a declared failure either — an `Err` is a resolved value — so
`Promise.all([...asyncResults])` collects every settled `Result` without fail-fasting, ready for
`partition`.

The invariant, stated once: **the value you get after awaiting is plain; only the thing you put
`await` in front of is thenable.** `lib/setup/config.ts` is the live example — it is `AsyncResult`,
not `Promise<Result>`, purely so a caller *can* chain; nothing that already only `await`s it had
to change.

`Result.from` is deliberately a **lift, not a universal `Array.from`-style converter**. It accepts
a `Promise<Result>` (a promise that already yields a Result and only rejects on a bug) and never a
raw `Promise<T>` — because a promise that can *reject* needs a declared `catch`, which has no slot
in a one-argument `from(x)` and would just reinvent `Result.try(promise, { catch })`. Nor does it
wrap a *function* into a Result-returning function: `Result.try(fn)` already takes a function and
*executes* it, so a `from(fn)` that instead *wrapped* it would give the same `function` argument
two incompatible meanings. `from` normalises into the async-Result world; `Result.try` is the one
boundary from throwing code — two verbs, no overlap. (This is why `neverthrow` keeps `fromPromise`
and `fromThrowable` as separate names rather than one overloaded `from`.)

---

## 4. Design decisions

Each of these is a place where the obvious choice is wrong.

### 4.1 The Result is plain data, not a class

This is the decision with the largest practical consequences, and almost every JS Result
library gets it wrong. `neverthrow`, `true-myth`, `Effect` and the `class Ok {}` / `class Err {}`
sketch from the design thread all represent a Result as a **class instance with methods**.

A class instance does not survive a boundary:

```ts
const result = Ok({ id: 1 });

structuredClone(result);           // plain object; `unwrap` is gone
worker.postMessage(result);        // plain object on the other side
JSON.parse(JSON.stringify(result)) // plain object
await (await fetch(url)).json()    // plain object
```

`structuredClone` (and therefore `postMessage`, `IndexedDB`, and the WebSocket/Worker paths)
copies own enumerable properties and **discards the prototype**. Methods live on the
prototype. So `result.ok` survives and `result.unwrap()` does not.

That is not a hypothetical for the framework in the design thread — it is a contradiction at
its centre. Its `Actor.ask` returns `Result.Err(new AppError(…))`, a class instance. Its
`WorkerActor.ask` returns `postMessage` output. Its `RemoteActor.ask` returns `await res.json()`.
So the framework has **three incompatible Result representations** behind one interface: local
actors return instances with methods, worker and remote actors return plain objects without
them. Any consumer that calls `.unwrap()` works locally and throws `is not a function` the day
the actor moves to a worker — which is precisely the day the actor model was supposed to make
easy.

Plain objects make the boundary a non-event:

```ts
// test/result/result-test.ts
const revived = JSON.parse(JSON.stringify(Result.ok({ id: 1 })));
Result.isResult(revived);   // true
revived.value;              // { id: 1 }
```

The cost is that combinators must be free functions (`Result.map(r, f)`) rather than methods
(`r.map(f)`). See §4.6 — this is a much smaller loss than it appears.

The error *inside* the Result is a different matter: `Failure` deliberately *is* a class,
because too much of the ecosystem keys off `instanceof Error` (Node's `util.inspect`, devtools
stack expansion, `unhandledRejection` reporting, every logger's error branch). That is why
`Failure.toJSON`/`fromJSON` exist and why using them is mandatory at a boundary. §9 covers
what happens if you forget.

### 4.2 Both variants have the same hidden class

```ts
export function ok<T>(value: T): Ok<T>  { return { ok: true,  value, error: undefined }; }
export function err<E>(error: E): Err<E> { return { ok: false, value: undefined, error }; }
```

`err` writes `value: undefined` it does not need. The reason is V8's object model: a hidden
class (map) is assigned per **key set × insertion order**. Writing the natural
`{ ok: false, error }` produces a second shape, so every `result.ok` load site that sees both
variants degrades from monomorphic to polymorphic inline caching.

Measured (Node 24.16.0, x86-64, 100 alternating reads per iteration):

| | ns per `.ok` read |
|---|---|
| one hidden class | 2.43 |
| two hidden classes | 2.98 |

~0.5 ns. This is a real effect and an almost totally unimportant one — it is included because
the claim is frequently made without a number, and the number turns out to be small. The
honest justification for the uniform shape is not speed; it is that `{ ok, value, error }`
destructures uniformly and `Object.keys()` is stable, which the test suite asserts.

### 4.3 An object, not a `[value, error]` tuple

The Lua/Go-shaped answer is a tuple, and `await-to-js` has made it popular:

```ts
const [err, data] = await to(fetchUser(id));
```

Three problems, in increasing order of severity.

1. **Positional, so it is memorised.** `await-to-js` returns `[err, data]`; other libraries
   return `[data, err]`. Both conventions are in wide use. Nothing catches a swap where the
   types are compatible.
2. **`T | null` collides with the sentinel.** If `T` can legitimately be `null` or `undefined`
   — a cache lookup, an optional field — `[null, null]` is ambiguous. The object form has a
   dedicated `ok` boolean that no payload can impersonate.
3. **Narrowing is fragile.** It *can* work: TypeScript 4.6+ narrows destructured discriminated
   unions, so `[E, null] | [null, T]` does narrow. But it narrows only for `const`
   destructuring in the same scope, breaks if the tuple is passed through a function, and
   silently degrades to `T | null` (with no error) rather than failing loudly.

The object form narrows everywhere, including destructured:

```ts
const { ok, value, error } = someResult;
if (ok) value.toFixed();     // number
else    error.code;          // narrowed
```

### 4.4 `Result.try` declares what it expects — the core differentiator

Everything else in this document is available in some form elsewhere. This is not.

```ts
const parsed = Result.try(() => JSON.parse(raw), { catch: SyntaxError });
```

If `JSON.parse` throws `SyntaxError`, that is an `Err`. If the surrounding line throws
`TypeError: Cannot read properties of undefined`, **it is rethrown**.

Compare what every other tool does:

```ts
try { … } catch (e) { … }                    // catches everything
Result.fromThrowable(fn)()                   // neverthrow: catches everything
Effect.try(fn)                               // catches everything
const [e, v] = await to(promise)             // catches everything
pcall(f)                                     // Lua: catches everything
```

Catching everything is *worse than no error handling* for the bug case. Without a `catch`, a
`TypeError` produces a stack trace pointing at the broken line. With one, it becomes a tidy
failure value flowing down the same code path as a legitimate outcome — and it ships.

The design thread's `Actor.ask` is the canonical instance of this:

```js
async ask(msg) {
  try {
    return await this.handler(msg, this);
  } catch (e) {
    return Result.Err(new AppError("ACTOR_CRASH", "Unexpected failure", { meta: { cause: e } }));
  }
}
```

Every bug in every handler becomes `ACTOR_CRASH` with HTTP 500. A typo'd property access and
a database outage are now the same observable event. (Three further problems in four lines:
`meta: { cause: e }` is not `Error.cause`, so no `cause`-walking tool sees it and it does not
serialize; `AppError` has no stack because it is constructed at the catch site rather than the
throw site; and `ACTOR_CRASH` is not in the route's declared `errors` list, so the generated
OpenAPI never mentions the response clients will most often get.)

The narrow-boundary rule generalises. Even `try/catch` should be written this way:

```ts
// bad — the catch also covers `render`, and a bug in render becomes "network failed"
try {
  const data = await fetchUser(id);
  return render(data);
} catch { return fallback; }

// good — the boundary covers exactly the fallible call
const user = await Result.try(() => fetchUser(id), { catch: NetworkError });
if (!user.ok) return fallback;
return render(user.value);      // a bug here throws, as it should
```

`Result.try` makes the narrow version shorter than the broad one, which is the only reliable way
to change what people write.

### 4.5 Discriminate on a string `code`, never `instanceof`

`instanceof` is realm-scoped. Each realm — an iframe, a `Worker`, a `vm` context, a
`MessageChannel` peer, a native addon — has its own `Error` binding and its own
`Error.prototype`. An error constructed in one and tested in another fails `instanceof` while
being, in every sense that matters, the same error.

This is not exotic for this project specifically: qunitx runs tests **inside a browser page**
and ships failures to Node over a WebSocket. Every error that crosses that link is
cross-realm by construction, and is additionally JSON-serialized, which destroys the prototype
anyway.

So the discriminant is a string:

```ts
switch (failure.code) {
  case 'FileMissing': …
  case 'Timeout': …
  default: assertNever(failure);
}
```

`isFailure` still uses a brand for the in-process case, and the brand is `Symbol.for('result.Failure')`
rather than `Symbol('result.Failure')` — the global symbol registry is per **process**, not per
realm, so the same key is retrieved in a Worker as on the main thread. That is the one
identity check that survives where `instanceof` does not.

### 4.6 Combinators are free functions, and mostly you should not use them

Because a Result is plain data, `map`/`mapErr`/`andThen` cannot be methods, so composition
reads inside-out:

```ts
andThen(map(parse(raw), normalize), validate)      // vs. parse(raw).map(normalize).andThen(validate)
```

This is a genuine ergonomic regression relative to `neverthrow`, and the honest response is
not to defend the ergonomics but to observe that **the combinators are rarely the right tool
in JavaScript.** In a language with `do`-notation (Haskell) or `?` (Rust) or `try` (Zig),
chaining is how you avoid pyramids. JavaScript already has the thing chaining substitutes for:
early return.

```ts
const config = await Result.try(() => readFile(path), { catch: errno('ENOENT') });
if (!config.ok) return defaults;

const parsed = Result.try(() => JSON.parse(config.value), { catch: SyntaxError });
if (!parsed.ok) return err(Invalid({ path }, { cause: parsed.error }));

return ok(normalize(parsed.value));
```

Flat, debuggable, breakpoint-able, and every failure is visibly handled. The combinators earn
their place in array pipelines (`items.map(…)` → `partition`), and nowhere else. `all` and
`partition` are the two that matter.

### 4.7 HTTP status codes do not belong on the error

The design thread puts `status = 500` on `AppError`. That couples the domain to one transport.
The same `FileMissing` is `404` over HTTP, exit code `1` over a CLI, a `NOT_FOUND` gRPC status,
and a retry over a queue. Map `code → status` in the HTTP adapter, where the knowledge belongs:

```ts
const STATUS: Record<string, number> = {
  FileMissing: 404, Invalid: 422, Denied: 403, Timeout: 504,
};
res.status(STATUS[failure.code] ?? 500).json(Failure.toJSON(failure));
```

This is also what makes the OpenAPI generation work properly — see §6.

---

## 5. Comparison

### 5.1 Against the JavaScript alternatives

| | typed failures | narrow boundary | survives worker/RPC | stack traces | happy-path cost | learning cost |
|---|---|---|---|---|---|---|
| bare `try`/`catch` | ✗ (`unknown`) | ✗ | n/a | ✓ | zero | none |
| `T \| null` sentinel | ✗ (reason lost) | ✓ | ✓ | ✗ | zero | none |
| `await-to-js` tuple | partial | ✗ | ✓ | ✓ | one array | none |
| `neverthrow` | ✓ | ✗ | **✗** | partial | one instance | moderate |
| `true-myth` | ✓ | ✗ | **✗** | partial | one instance | moderate |
| `fp-ts` `Either` | ✓ | ✗ | **✗** | ✗ | one instance | high |
| `Effect` | ✓ (in signature) | ✓ (typed errors) | ✗ | ✓ | fiber runtime | very high |
| **this design** | ✓ | ✓ | ✓ | ✓ | one literal | low |

Two columns deserve elaboration.

**"Survives worker/RPC"** is §4.1. It is marked as a hard failure for the class-based
libraries because the failure is *silent*: the object arrives, `.ok` reads correctly, and only
the method call throws — often on a rarely-taken branch.

**Effect** is the only entry that is genuinely more powerful. `Effect<A, E, R>` puts the error
type *and the dependency set* in the signature, gives real structured concurrency,
interruption, retry schedules and tracing, and its typed-error story is better than this one
(errors accumulate in a union automatically as you compose). The reasons not to reach for it
are that it colours every function in the codebase, requires the whole team to learn an
effect system, does not interoperate with plain `async`/`await` without ceremony, and adds a
runtime. If you are building a framework and can mandate it top to bottom, Effect is a serious
answer. If you want something you can adopt in one function this afternoon and delete next
month, it is not.

### 5.2 Against Lua

The question that prompted this was whether Lua's approach is better for JavaScript. Mostly
yes, and it is what §2 adopts. Two things do not transfer:

**Multiple return values.** `local ok, err = pcall(f)` costs nothing in Lua because the VM has
genuine multiple returns. JavaScript has no such thing; every equivalent allocates a container
(array or object). This is why the JS version must think about the container's shape (§4.2)
where Lua does not.

**`xpcall`'s message handler runs before unwinding.** This is the real loss:

```lua
xpcall(f, debug.traceback)   -- handler runs AT the error point, stack still live
```

JavaScript has **one-phase exception handling**. By the time a `catch` clause runs, the stack
between the throw and the catch is gone. All that survives is whatever the `Error` object
snapshotted in its own constructor. So `Result.xpcall` exists and is useful for normalising
failures at a boundary, but it cannot do what Lua's does, and no JS library can. (Python's
`sys.exc_info()` traceback object and .NET's two-pass SEH filters both preserve more.) The
practical consequence: **construct your error where the failure happens, not where you catch
it** — a `new AppError(…)` built inside a `catch` has a stack pointing at the catch.

### 5.3 Against other languages, briefly

- **Rust** `Result<T, E>` + `?`. The model this borrows. `?` is the piece JavaScript cannot
  have; early return is the substitute and it is wordier.
- **Go** `(T, error)`. Same two-tier model, no exhaustiveness, and `if err != nil` everywhere.
  Go's `errors.Is`/`errors.As`/`%w` wrapping is the direct analogue of `code` matching and
  `cause` chaining here.
- **Zig** error unions + `try`. The strongest static story: the error set is *inferred* from
  the function body, so it cannot drift from reality. TypeScript cannot infer a throw set, and
  that is exactly the gap `Result.try`'s explicit `catch` list papers over by hand.
- **Swift** `throws`, and since Swift 6, *typed* throws (`throws(MyError)`). Notable because
  Swift arrived at checked exceptions after starting without them, and confined them to a
  single error type per function to avoid Java's ergonomic disaster.
- **Java** checked exceptions — the cautionary tale. Checked exceptions failed less because
  checking was wrong than because there was no cheap way to *widen* or *ignore* them, so
  everyone wrote `catch (Exception e) {}`. Any design here must keep the escape hatch cheap:
  `Result.pcall` and `Result.unwrap` are that escape hatch, deliberately one word each.
- **Erlang/Elixir** "let it crash" + supervision, plus the `{:ok, value} | {:error, reason}`
  tuple convention. Same two tiers again: tagged tuples for expected failures, crashes for
  bugs, supervisors as the boundary. The design thread's actor model is reaching for this;
  §6 covers what it would actually take.

---

## 6. Review of the actor/route/OpenAPI design

The thread's overall architecture — declarative routes, actors, `Result` in, `Result` out,
generated docs — is sound, and the error system in this document is a drop-in for its weakest
layer. Concrete defects, in priority order:

1. **`class AggregateError extends Error` shadows the ES2021 global.** `AggregateError` has
   been a standard built-in since ES2021 and is what `Promise.any` rejects with. Redefining it
   means `catch (e) { e instanceof AggregateError }` silently stops matching real ones. Use
   `Failure.define('PartialFailure', …)` with the failures in `data`.

2. **`Ok`/`Err` as classes.** §4.1. This breaks the framework's own `WorkerActor` and
   `RemoteActor`.

3. **`Actor.ask`'s blanket catch.** §4.4. Every bug becomes `ACTOR_CRASH`/500.

4. **The typed `Err` is not assignable.** In the TS section:

   ```ts
   type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E };
   const Ok = <T>(value: T): Result<T> => ({ ok: true, value });
   ```

   `Ok(x)` is typed `Result<T, AppError>`, so it does not fit a `Result<T, ValidationError>`
   slot. Constructors must return the *variant*, not the union: `ok<T>(v): Ok<T>`, so `E` stays
   free to unify with whatever the failing branch produces.

5. **`errors: ['USER_NOT_FOUND', 'PARTIAL_FAILURE']` is hand-maintained and unenforced.**
   Nothing checks that the actor can actually produce those, or that it produces no others.
   With `Failure.Of<…>` the declaration comes from the type:

   ```ts
   const getProfile = actor(async ({ id }): Promise<Result<Profile, Failure.Of<typeof UserNotFound | typeof Denied>>> => …);
   ```

   and the route's error list is derived rather than restated.

6. **The OpenAPI generator collapses every error to one response.**

   ```js
   ...Object.fromEntries(r.errors.map((e) => [400, { description: e }]))
   ```

   Every entry has the literal key `400`, so `Object.fromEntries` keeps only the last one. A
   route declaring five failures documents one. With a `code → status` map (§4.7) the keys are
   distinct and each response can carry the `SerializedFailure` schema.

7. **`meta: { cause: e }` instead of `cause`.** Loses `Error.cause` interop: Node's inspector,
   `util.inspect`'s `[cause]` rendering, and every chain-walking logger.

8. **`workerLoop`'s `while (true)` spins.** When `worker.queue.pop()` and `stealWork()` both
   return nothing, the loop `await`s nothing and busy-waits at 100% CPU. It needs a real
   suspension point.

Zod is the right call for validation, and it composes cleanly here — `safeParse` already
returns a Result in all but name:

```ts
export function validate<T>(schema: z.ZodType<T>, input: unknown): Result<T, Failure.Of<typeof Invalid>> {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(Invalid({ issues: parsed.error.issues }));
}
```

Note `issues` goes in `data` — typed, serializable, and directly renderable into the OpenAPI
error schema — rather than into a `meta: Record<string, any>` bag.

---

## 7. Performance, measured

Node 24.16.0, x86-64 Linux, stack depth 10 unless noted, 1M iterations after warmup.
Reproduce with `lib/result/` and the harness in this document's commit message.

**Happy path — the only number most code cares about:**

| | ns/op |
|---|---|
| return the value directly | 71.6 |
| `return ok(value)` | 72.7 |
| `try`/`catch` around a success | 65.7 |
| `Result.try(fn)` on a success | 60.8 |

All within noise of each other. **A Result costs nothing on the success path**, and `try/catch`
has not been a deoptimization barrier in V8 since TurboFan (2017). Any argument for or against
this design on happy-path performance grounds is unfounded in both directions.

**Failure path:**

| | depth 10 | depth 60 |
|---|---|---|
| `throw new Error` + `catch` | 9 224 | 13 028 |
| `return err(Failure())` | 10 918 | 11 135 |
| `return err(Failure(…, { stackless: true }))` | **966** | **1 219** |
| `return err('string')` | 66.6 | — |

**Cost decomposition** — this is the important table:

| | ns/op |
|---|---|
| `new Error()` (stack captured) | 7 763 |
| `new Error()` with `Error.stackTraceLimit = 0` | 494 |
| throwing and catching an already-constructed `Error` | 5 425 |

**~94% of what an error costs is the stack capture, not the throw.** V8 collects structured
frames eagerly in the `Error` constructor and only *formats* them lazily on first `.stack`
access. This has three consequences:

1. "Exceptions are slow" is really "`new Error()` is slow". Returning an `Err` carrying a
   `Failure` is not meaningfully cheaper than throwing one, because both pay the capture.
2. The saving is available to either style via `{ stackless: true }` — a 10× reduction — and
   the trade is real: no stack means no debuggability, so it is worth it only for failures
   produced in a hot loop and consumed immediately.
3. Cost grows with stack depth for `throw` (9.2 → 13.0 µs) but not for a returned failure
   (10.9 → 11.1 µs), because a returned failure's capture is anchored and bounded while the
   throw additionally pays unwinding. At depth 60 **returning is already cheaper than
   throwing**.

This measurement also caught a bug in this implementation. `Failure` anchors its stack at the
factory (so the top frame is the caller, not `failure.ts`), which naively means
`super(message)` captures once and `Error.captureStackTrace` captures again — measured at
17 454 ns, almost exactly 2× a plain `Error`. Zeroing `Error.stackTraceLimit` across the
constructor makes the unavoidable first capture ~16× cheaper, bringing anchored construction
to 10 918 ns and, incidentally, making `stackless` actually stackless (it was previously still
paying `super()`'s capture: 9 636 → 966 ns).

---

## 8. Corner cases

Everything below is either covered by a test in `test/result/` or is a documented limitation.

### 8.1 Anything can be thrown

`throw 'string'`, `throw null`, `throw undefined`, `throw { code: 42 }` are all legal and all
occur — most often as `Promise.reject(nonError)` from DOM and legacy callbacks.
`Failure.from()` normalises any of them, preserving the original under `cause`. `unwrap()` on a
non-`Error` failure wraps it so that something with a `.stack` always propagates.

`Result.err(undefined)` is still a failure — `ok` is the discriminant, not truthiness.

### 8.2 `JSON.stringify(new Error('boom'))` is `{}`

`message` and `stack` are own-but-non-enumerable; `name` is on the prototype. Any error sent
over a WebSocket, `postMessage`, or an HTTP body must be converted explicitly. `Failure` has a
`toJSON` method, so `JSON.stringify(failure)` works; use `Failure.toJSON(anyError)` for
everything else.

### 8.3 `structuredClone` does not preserve custom error properties

The structured clone algorithm handles `Error` specially: it keeps `name`, `message`, `stack`
and `cause`, and discards the subclass along with **every own property you added**. So `code`
and `data` do not survive it, and `Failure.is()` correctly returns `false` for a cloned
failure. Serialize with `toJSON`, not `structuredClone`.

### 8.4 A Node system error is not a Failure

Every errno error has a string `code` and a string `message`. A purely structural
`isFailure` would report `true` for `ENOENT`, after which `error.data` reads `undefined`
forever. The wire form therefore carries an explicit `failure: true` marker, and the
structural check requires it.

### 8.5 The revived stack is the *remote* stack

`Failure.fromJSON` restores the `stack` string from the producing process. Over a
browser→Node WebSocket that is a feature — the frames point at the browser code that actually
broke. It is a trap if you forget: those frames do not exist in this process.

### 8.6 Cyclic and unbounded `cause` chains

`a.cause = b; b.cause = a` is constructible. `causes()` is cycle-safe (identity `Set`) and
depth-capped at 32. A logger is the last thing that should be able to lock up a process.

### 8.7 Unserializable payloads fail at the boundary, not in the caller

A circular reference, a `BigInt`, or a function inside `data` would otherwise throw from
inside the caller's `JSON.stringify` — replacing the error being reported with a different
one. `toJSON` round-trips `data` eagerly and substitutes `{ unserializable: … }`.

### 8.8 `finally` can swallow an in-flight exception

Unchanged by this design, and worth restating because it is the most under-known footgun in
the language:

```ts
try { throw new Error('boom'); } finally { return 1; }   // returns 1; the error vanishes
```

A `return`, `break` or `continue` in `finally` discards a propagating exception. Never do
control flow in `finally`.

### 8.9 Cleanup errors mask the original

```ts
try { throw new Error('original'); } finally { await close(); }   // if close() throws, 'original' is lost
```

Plain `finally` has no suppressed-exception list (Java's `getSuppressed()`). Explicit resource
management does: `SuppressedError` (with `.error` and `.suppressed`) is live in Node 24
alongside `using` and `DisposableStack`, and is what a disposer's throw produces when it
displaces an in-flight error. It applies only to `using`/`DisposableStack`, not to `finally`,
so for ordinary cleanup wrap it explicitly:

```ts
const cleanup = await Result.try(() => close());
if (!cleanup.ok) log(cleanup.error);   // never let it displace the real failure
```

This repo has the pattern already: `closeWithGrace()` uses `Promise.allSettled` so a failing
close cannot displace the original error — though it also discards every close failure
unreported, which is the opposite mistake.

### 8.10 `Promise.all` discards successes; `Result.try` does not

`Promise.all` rejects on the first failure and throws away every success that had already
settled, plus every other failure. Because `Result.try`'s promise never rejects for a declared
failure, this is safe and lossless:

```ts
const results = await Promise.all(files.map((f) => Result.try(() => readFile(f), { catch: errno() })));
const { values, errors } = Result.partition(results);
```

`Promise.allSettled` gets you the same completeness with `{ status, value, reason }` and an
untyped `reason`.

### 8.11 `AggregateError` and `Promise.any`

`Promise.any` rejects with a real `AggregateError` whose `.errors` is an array. Match it with
`Result.try(fn, { catch: AggregateError })` — and do not define your own class with that name (§6).

### 8.12 Cancellation is not a failure

An aborted operation is a third state, distinct from success and from failure: nobody wants a
retry, an alert, or a 500. This design models it as a failure with a dedicated code
(`Aborted`), because a fourth variant would infect every signature, but the distinction must be
preserved at the boundary:

```ts
if (!result.ok && result.error.code === 'Aborted') return;   // not an error to report
```

Note also that `AbortSignal` rejects with a `DOMException` named `AbortError`, not an
`Error` subclass you can `instanceof` portably — match on `name === 'AbortError'`. This
repository currently has **zero** `AbortSignal` uses and hand-rolls every cancellation with
`Promise.race` + `setTimeout`, which is why timeouts here surface as `signal: 'SIGTERM'` rather
than as a distinct failure.

### 8.13 The thunk form catches more than the promise form

```ts
Result.try(() => fetch(badUrl), { catch: TypeError })  // catches fetch's synchronous TypeError
Result.try(fetch(badUrl), { catch: TypeError })        // cannot — the throw happens while evaluating the argument
```

Always prefer the thunk. The promise form exists for values you already hold.

### 8.14 `unwrap` vs `expect` — whose stack do you want?

`unwrap` rethrows an `Error` failure **by identity**, so the stack still points at the origin.
`expect(result, message)` throws a fresh error with the original under `cause`, so the stack
points at the code that demanded the value. Neither is right in general; pick per site.

### 8.15 Exhaustiveness

```ts
switch (failure.code) {
  case 'FileMissing': return 404;
  case 'Denied':      return 403;
  default: {
    const _exhaustive: never = failure;   // compile error if a code is added and unhandled
    return 500;
  }
}
```

This only works if `E` is a union of literal codes rather than `Failure.Any`. Widening to
`Failure.Any` at a boundary is fine and often right; widening it *early* silently discards the
exhaustiveness guarantee, which is the main thing the type was buying.

### 8.16 What TypeScript still cannot do

There are no checked exceptions, and `Result.try`'s `catch` list is **asserted, not verified**.
If you declare `SyntaxError` and the function also throws `RangeError`, the compiler will not
tell you; the `RangeError` propagates at runtime. That is the correct default (an undeclared
failure is a bug), but it is not the guarantee Zig gives you by inferring the error set from
the body. `catch (e)` is `unknown` under `useUnknownInCatchVariables` (implied by `strict`) —
keep it on.

### 8.17 Things that cannot be caught at all

Stack overflow raises a catchable `RangeError`, but the handler runs with a nearly-full stack
and can itself overflow. Out-of-memory is not catchable — the process dies. `process.exit()`
inside a `try` runs no `finally`. Errors thrown from an `EventEmitter`'s `'error'` event with
no listener become uncaught exceptions rather than rejections; this repo attaches no-op
`'error'` listeners on child stdio for exactly this reason.

---

## 9. Tutorial

### Step 1 — declare the failures a module can produce

At the top of the module, next to the types. This is documentation the compiler reads.

```ts
// lib/config/failures.ts
import { Failure } from '../result/index.ts';

export const NotFound = Failure.define('ConfigNotFound', (d: { path: string }) => `no config at ${d.path}`);
export const Invalid  = Failure.define('ConfigInvalid',  (d: { path: string; reason: string }) => `${d.path}: ${d.reason}`);
export const Denied   = Failure.define('ConfigDenied',   (d: { path: string }) => `cannot read ${d.path}`);
```

### Step 2 — put the failures in the signature

```ts
import { type Result, ok, err, errno, Failure } from '../result/index.ts';

type LoadFailure = Failure.Of<typeof NotFound | typeof Invalid | typeof Denied>;

export async function load(path: string): Promise<Result<Config, LoadFailure>> {
```

The signature now states every way this can fail. That is the whole point; everything below is
mechanics.

### Step 3 — convert at the boundary, narrowly, declaring what you expect

```ts
  const read = await Result.try(() => fs.readFile(path, 'utf8'), { catch: errno('ENOENT', 'EACCES') });
  if (!read.ok) {
    return err(
      read.error.code === 'ENOENT'
        ? NotFound({ path }, { cause: read.error })
        : Denied({ path }, { cause: read.error }),
    );
  }
```

`errno('ENOENT', 'EACCES')` declares the two expected failures. An `EISDIR`, or a `TypeError`
from a bad argument, is *not* declared and therefore throws — which is what you want, because
neither has a sensible local response. `cause` keeps the original errno error and its stack.

### Step 4 — keep converting, never widening

```ts
  const parsed = Result.try(() => JSON.parse(read.value), { catch: SyntaxError });
  if (!parsed.ok) {
    return err(Invalid({ path, reason: parsed.error.message }, { cause: parsed.error }));
  }

  return ok(parsed.value as Config);
}
```

Each step maps a low-level failure to a domain failure and files the original under `cause`.
The caller sees three codes, not three libraries' worth of error types.

### Step 5 — handle exhaustively at the top

```ts
const config = await load('./qunitx.json');
if (!config.ok) {
  switch (config.error.code) {
    case 'ConfigNotFound': return DEFAULTS;
    case 'ConfigDenied':   process.exitCode = 77; break;
    case 'ConfigInvalid':  process.exitCode = 78; break;
    default: { const _: never = config.error; }
  }
  console.error(Failure.format(config.error));   // renders the whole cause chain
  return;
}
use(config.value);
```

Adding a fourth code to `LoadFailure` now fails to compile here. That is the guarantee.

### Step 6 — cross a boundary

```ts
// producer (browser page, worker, service)
socket.send(JSON.stringify(Result.mapErr(result, Failure.toJSON)));

// consumer (node)
const wire = JSON.parse(frame);
const result = Result.mapErr(wire, Failure.fromJSON);
if (!result.ok) console.error(Failure.format(result.error, { stacks: true }));
```

The Result itself needs no conversion — it is plain data. Only the error inside does.

### Step 7 — batch work without losing anything

```ts
const results = await Promise.all(paths.map((p) => load(p)));
const { values, errors } = Result.partition(results);
console.error(`${errors.length} of ${paths.length} configs failed`);
```

### Step 8 — escape when you should

At a top-level boundary, or in a test, or anywhere a failure genuinely is unrecoverable:

```ts
const config = Result.expect(await load(path), 'the bundled default config must load');
```

Do not spread Results into code that has no plan for them. A `Result` that is always
`unwrap`ped adds ceremony and removes nothing — throw instead.

---

## 10. When *not* to use this

This matters more than the rest of the document, because the failure mode of a good error
abstraction is applying it everywhere.

- **When there is exactly one failure mode and one response.** `pathExists()` returning
  `boolean` is correct and a `Result<boolean, StatFailure>` is worse.
- **When the caller has no plan.** If every call site does `unwrap()`, the failure is a bug.
  Throw.
- **In leaf utilities with no domain meaning.** `indentString`, `convertToPascalCase`. If it
  can only fail by being called wrongly, that is a bug.
- **Hot loops that produce failures.** Constructing a `Failure` per iteration costs ~11 µs
  with a stack. Use `{ stackless: true }`, or a plain sentinel, or restructure.
- **Across a library's public API you do not control both sides of.** Consumers expect
  `throw`. Offer the throwing API and keep Results internal, or offer both.
- **Wholesale, in one commit.** The value is per-function and it composes with code that has
  not converted. Convert the functions whose failures callers actually branch on.

---

## 11. Verdict for this repository

Adopt for the ~15 sites where a failure is genuinely branched on, not for the 85 `catch`
blocks. In descending order of value:

1. **`test/helpers/shell.ts`'s `shellFails`** — already done in this branch as a worked
   example. It previously returned `CapturedResult | CapturedError | Error` with no
   annotation, forced a successful run's `code` to `0` and relied on the caller remembering to
   assert on it, and returned a spawn-level `ENOENT` as a value whose `code` was `undefined`
   (so a missing binary reported "expected 1, got undefined"). It now declares the one failure
   it expects, returns a typed `CapturedResult`, throws on unexpected success, and lets a
   spawn failure propagate as itself.

   Tightening it immediately found a real misuse. `test/flags/only-failed-test.ts` routed
   *every* CLI invocation through `shellFails`, including four that assert `exitCode(…, 0)` —
   it wanted "run this and give me the result" and reached for the helper whose name promises
   a failure. Under the old implementation the mismatch was invisible, because a successful
   run was returned with `code` rewritten to `0` and the `exitCode(…, 0)` assertions then
   passed *for the wrong reason*. That call site now uses a new `shellSettles`, which states
   the actual contract: either exit code is fine, a spawn failure is still not.

2. **`lib/args/parse.ts`** — return `Result<ParsedFlags, Failure.Of<…>>` instead of
   `console.error` + `process.exit(1)` at seven sites. `cli.ts` prints and exits; the daemon
   returns an error to the client instead of dying; and `test/args/parse-test.ts` deletes its
   `process.exit` monkeypatch.

3. **`lib/setup/get-changed-fs-tree.ts`** — the `Set<string> | null | Error` union with two
   opposite-meaning sentinels becomes
   `Result<Set<string>, GitFailure> | 'run-everything'`, or a three-variant tagged union.

4. **The esbuild catch at `tests-in-browser.ts:404`** — separate `DaemonRunError` control
   flow from `BundleFailed` from `NavigationTimeout`. `deriveBuildErrorType`'s four regexes
   become a `code` set on `data`, and `formatBuildErrors` becomes a renderer rather than half
   of an ad-hoc error factory. This also removes `BundleError`'s TAP `# ` prefixing, which is
   presentation logic baked into an error message.

5. **`lib/commands/daemon/client.ts:116-128`** — `resolve(1)` for a fatal chunk, a socket
   close and a socket error means "the daemon crashed" is reported to CI as "one test failed".

Deliberately **not** converted to Results: the 28 cleanup `.catch(() => {})` calls on
`unlink`/`rm`/`close`/`dispose`, where the failure genuinely has no consequence. Wrapping
those would add ceremony and remove nothing. They now carry `Failure.ignore('<what>')`
instead — the open TODO item *"make all `.catch(() => {})` print something to debug"* — so a
suppressed failure is labelled and visible under `QUNITX_DEBUG` while still costing nothing on
the normal path.

Three of those sites are worth knowing about, because they are *not* cleanup and the label now
says so: `run.ts`'s two `preBuildPromise.catch(() => {})` calls and `web-server.ts`'s
`activeRebuild.catch(() => {})` are **rejection-deadline extensions**, not error handling. The
real handling happens at a distance, when `runInBrowser` re-awaits the same promise inside its
own `try`. Nothing enforces that coupling; a refactor that drops the distant `await` turns
every watch-mode build failure into silence. The labels are the only thing currently pointing
at it.
