# JavaScript / TypeScript API

Everything the CLI does, available as a function — for CI scripts, editor integrations, agents,
and anything else that needs the results as data rather than as text on a terminal.

```js
import { test } from 'qunitx-cli';

const result = await test('test/');

result.ok; // false
result.counts; // { total: 42, passed: 41, failed: 1, skipped: 0, todo: 0, assertionsFailed: 1 }
result.failures.map((one) => one.fullName); // ['Cart > Coupons: applies code']
```

- [Four things to know](#four-things-to-know)
- [`test`](#test) · [`run`](#run) · [`openSession`](#opensession) · [`watch`](#watch) · [`search`](#search) ·
  [`Daemon`](#daemon) · [`init` / `generate`](#init--generate) · [`validate`](#validate)
- [The result](#the-result) · [Notices](#notices--why-ok-alone-is-not-enough)
- [Custom reporters](#custom-reporters) · [Tutorial: a nyan cat reporter](#tutorial-a-nyan-cat-reporter)
- [Where output goes](#where-output-goes) · [Errors](#errors) · [Deno, JSR and types](#deno-jsr-and-types)

## Four things to know

- **Nothing is printed unless you ask.** The returned result is the whole answer. Pass
  `reporter: 'tap'` (or `'spec'`, `'dot'`, `'github'`) to get the CLI's output too.
- **Failing tests are not an error.** `test()` resolves with `ok: false`. It rejects only when the
  run could not happen — a bad option, an unreadable input, no `package.json`.
- **It is lazy.** Every verb returns a `Task` (a Promise superset), so nothing starts until you
  `await` it. `.result()` gives you the outcome as a value instead of throwing.
- **It is the same engine as the CLI**, taking the same code path, so behaviour cannot drift.

## test

One run, one answer.

```js
import { test } from 'qunitx-cli';

const result = await test({
  inputs: ['test/', 'src/cart-test.ts#34'], // same grammar as the command line
  filter: 'Cart',
  browser: 'chromium',
  coverage: { formats: ['lcov'] },
  junit: true,
  reporter: 'spec', // omit for silence
});
```

Three call shapes, and `watch` and `openSession` take the same three:

```js
await test('test/'); // a file or directory
await test(['a-test.ts', 'b-test.ts']); // several
await test({ inputs: ['test/'], filter: 'Cart' }); // one options object
await test('test/', { filter: 'Cart' }); // target first, options second
```

The positional target wins over any `inputs` in the options object — naming it there is the more
specific statement. Every CLI flag has an option — see the
[CLI Reference](../README.md#cli-reference).

**Cancelling.** Pass a `signal`. An already-aborted one answers without launching a browser at
all, and a cancelled run still resolves with the tests that finished:

```js
const controller = new AbortController();
const result = await test({ inputs: ['test/'], signal: controller.signal });
result.status; // 'aborted' — counts are a prefix of the suite, not a verdict on it
```

`status` distinguishes _stopped_ from _red_ — both come back `ok: false`:

| `result.status` |                                                                               |
| --------------- | ----------------------------------------------------------------------------- |
| `'completed'`   | every selected test reached an outcome; `counts.total` is the whole selection |
| `'aborted'`     | cut short by `session.abort()`, the CLI's `qq`, or a `signal`                 |
| `'failFast'`    | `failFast` was set and a test failed, so the rest of the queue was dropped    |

Check it before reporting a red run as red. Without it, a `failFast` run of a 200-test suite is
indistinguishable from a complete run of a 2-test one — both `ok: false`, both `counts.total: 2`.

### Picking up where a run stopped

There is no `resume()`, and there cannot be a real one: QUnit 2.x has no pause/resume — `abort`
empties its queue, and `QUnit.start()` throws if the run is already going — and the browser is
torn down afterwards, so no page state survives to resume _into_.

What you usually want instead is "run the ones that never ran", and that composes out of what is
already here: `search()` knows the whole selection, the result knows what ran, and a line target
addresses an exact declaration.

```js
const first = await test({ inputs: ['test/'], failFast: true });

if (first.status !== 'completed') {
  const { matches } = await search({ inputs: ['test/'] });
  const ran = new Set(first.tests.map((test) => test.fullName));
  const remaining = matches.filter((match) => !ran.has(match.fullName));

  const rest = await test({ inputs: remaining.map((match) => `${match.file}#${match.line}`) });
}
```

Three things this leans on, all of them worth knowing before you rely on it:

- **A fresh browser, not a continuation.** Each run starts clean, so this only holds if your tests
  are independent of one another — which they should be anyway, but nothing here enforces it.
- **Runtime-named tests are invisible to it.** ``test(`case ${index}`)`` in a loop is _one_
  declaration with no literal name, so `search()` counts it under `unlistable.computedNames` and
  cannot list the tests it becomes. They would never be picked up. Check
  `unlistable.total === 0` before trusting the remainder, and fall back to re-running whole files
  if it is not.
- **The selection must not have changed** between the two calls — `search()` re-reads from disk.

For a watch session, prefer `session.run(files?)`, which reuses the browser that is already open.

## run

One file, executed as a plain script in the browser — the API twin of `qunitx run <file>`, and the
counterpart to `test()`. No QUnit, no TAP, no test declarations required.

```js
import { run } from 'qunitx-cli';

const result = await run('scripts/seed.ts');

result.ok; // true when the script exited 0
result.exitCode; // globalThis.exitCode if the script set one, 1 if it threw, else 0
result.durationMs; // 412
result.file; // '/proj/scripts/seed.ts' — absolute, whatever you passed
result.value; // whatever the script default-exported, or undefined
result.valueProblem; // null, or why there is no value despite an export
result.browserLogs; // everything it printed, in emit order
result.browserLogsDropped; // 0, unless it out-printed the cap
```

The script is bundled with esbuild (TypeScript and JSX work unchanged) and evaluated as a module,
so it gets a DOM, `fetch` against a real `http://localhost` origin, `import.meta` and top-level
`await`.

Options are `cwd`, `browser`, `port`, `timeout`, `open` and `console`. There is no `watch`: a
watching script never finishes, so it cannot be a `Task` that resolves, and it needs a session type
of its own.

### The value it exported

A module cannot `return`, so a script hands a value back by default-exporting it:

```js
// scripts/seed.ts
const rows = await seedDatabase();
export default { seeded: rows.length, ids: rows.map((row) => row.id) };
```

```js
const { value } = await run('scripts/seed.ts'); // { seeded: 3, ids: [1, 2, 3] }
```

A script with no default export has `value: undefined`.

The value crosses a process boundary as JSON, so only JSON-safe data survives: null, booleans,
finite numbers, strings, arrays and plain objects. Anything else — a `Map`, a `Date`, a function, a
class instance, `NaN` — is **withheld rather than altered**, and `valueProblem` says which field:

```js
// scripts/build.ts — both runnable and importable
export default function main() {}
```

```js
const result = await run('scripts/build.ts');

result.ok; // true — this is an ordinary script
result.value; // undefined
result.valueProblem; // 'the value is a function'
```

This never fails the run and never affects `ok` or the exit code. The script ran; what it exported
is a separate question, and `qunitx run` on the command line ignores it entirely.

### What the script printed

Its `console` calls stream to this process's stdout and stderr as they happen, and are **also**
recorded on the result. `console` and `browserLogs` are a tee, not a switch — routing the output
elsewhere never loses it:

```js
const quiet = await run('scripts/seed.ts', { console: silentConsole });

quiet.browserLogs; // still every line — silence chose the destination, not the recording
quiet.browserLogs[0]; // { type: 'log', text: 'seeding…', args: [] }
```

Same shape and same cap a test run reports, because it is the same thing — a page's console read
over CDP. `type` is the page's own level (`log`, `warning`, `error`, `info`, `debug`, or
`pageerror` for an uncaught throw), so stdout-versus-stderr is derivable and `warn` stays
distinguishable from `error` — a distinction the two-stream split cannot express.

Capped at the most recent 1000 entries so a script that prints in a loop cannot grow the array
until the process dies; `browserLogsDropped` counts what fell off the front, so a truncated log is
never silently truncated.

**A non-zero exit code is a result, not a rejection** — the same contract `test()` has for a red
suite. It rejects only when the script could not be run at all: no such file, a bundle that will
not build, or a target that is not a single file.

> **This verb used to run a suite.** `run(options)`, `run('tests/')` and `run(['a.ts'])` are now
> `test(...)`. Every one of those shapes is refused here with a message naming `test()`, so the
> change of meaning cannot pass silently:
>
> ```js
> await run('test/').result(); // NotAScriptFile: run() takes one script file, but 'test/' is a
> // directory. To run a test suite, call test('test/') instead.
> ```
>
> The single case that cannot be caught is `run('one-file.ts')`, which was a legal suite call and
> is a legal script call. The return type differs, so TypeScript flags it; untyped callers should
> check that one by hand.

## openSession

One run, watched as it happens. `test()` is the smaller thing when only the outcome matters; this
is for when the _progress_ is the point.

```js
import { openSession } from 'qunitx-cli';

await using session = await openSession('test/');

for await (const event of session) {
  if (event.kind === 'test') process.stdout.write(event.test.status === 'passed' ? '.' : 'F');
}

const result = await session.result(); // RunResult — never undefined
```

Events are `runStart`, `test`, `notice`, `browserLog`, and finally `runEnd`, which carries the
complete result — so a consumer reading only this feed never needs a second channel. Watch
sessions emit the same shape, so a display written against one works against the other.

**The run does not start until you consume it.** That is a correctness property, not an
optimization: a browser cannot be told to slow down, so a run started before anyone was reading
would either drop events or buffer the whole suite. Awaiting `result()` counts as consuming.

The event feed is capped, so a consumer that falls behind under a flood of page output loses the
oldest events — `session.droppedEvents` says how many, `0` in any ordinary run. `runEnd` is
emitted last and always survives, so the result reaches you either way.

## watch

An async-iterable session that yields a complete result per rerun, and closes deterministically.
No keyboard shortcuts are installed and your stdin is left alone — the behaviours behind them are
methods instead.

```js
import { watch } from 'qunitx-cli';

const session = await watch({ inputs: ['test/'] });
console.log(session.url); // http://localhost:1234

for await (const result of session) {
  console.log(`${result.counts.passed}/${result.counts.total}`);
  if (result.ok) break; // breaking out closes the session
}
```

The session is a handle with the same verbs the CLI's keyboard shortcuts are bound to — the CLI
binds keys to these methods, so a terminal UI built on this API is not reimplementing them:

```js
await session.run(files?); // rerun, optionally scoped     (the file watcher's own path)
await session.runAll(); // whole suite, drops line targets  (`qa`)
await session.runFailed(); // only what failed last run     (`qf`)
await session.abort(); // stop the run in flight            (`qq`)
await session.restart(); // rebuild the machinery, keep the session
await session.close(); // release the browser and the port

session.latest; // the most recent result, without consuming the iteration
session.running; // is a run executing or queued
```

### Rerunning: which verb reruns what

The four rerun verbs differ in what they carry over, and the differences are the point:

|                      |                                                                   |
| -------------------- | ----------------------------------------------------------------- |
| `run()`              | **rebuilds** the bundle, then reruns — the same path a save takes |
| `run(['a-test.ts'])` | runs those files from the **current** bundle, no rebuild          |
| `runFailed()`        | reruns the files that failed last time                            |
| `runAll()`           | the whole suite, dropping line targets                            |
| `restart()`          | rebuilds browser, page, server and watchers first, then runs once |

The rebuild difference matters if you edited a file and then called `run([thatFile])`: you get the
existing bundle, so the edit is not in it. `run()` with no arguments is the one that picks up
changes on disk.

**`runFailed()` with nothing failing repeats the last run**, and says so with an `info` notice on
the result rather than silently doing something else:

```js
const result = await session.runFailed();
result.notices.some((n) => n.message.includes('No tests failed in the last run')); // true
```

That is deliberate: a verb bound to a keypress should always do something, and "nothing failed, so
I ran nothing" is indistinguishable from a broken binding.

### Filtering: what survives a rerun, and what does not

Two kinds of narrowing behave differently, because they mean different things:

| narrowing                            | set by                        | survives `runAll()`?    |
| ------------------------------------ | ----------------------------- | ----------------------- |
| name filter (`-t` / `-m` on the CLI) | `watch({ filter: 'Cart' })`   | **yes**                 |
| line target (`test/cart-test.ts#34`) | `watch({ inputs: ['…#34'] })` | no — `runAll` clears it |
| file scope                           | `run(['test/cart-test.ts'])`  | n/a — per call only     |

A **name filter is a standing instruction** about which tests should run, so every rerun keeps it,
including `runAll()`. A **line target is a starting point** — you asked to begin at one test — and
`runAll()` is the verb that says "now give me everything". `run(files)` narrows a single call and
leaves the session's own selection untouched.

There is no per-rerun name filter: to change `filter`, close the session and open another. It is a
property of the selection the session was built from, not a per-call argument.

### Teardown

`close()` is the one teardown verb, and it is deliberately the only one — no separate closes for
the browser, the server or the bundler:

```js
await session.close(); // browser down, port released, watchers stopped, iteration ended
await session.close(); // idempotent — safe to call again
```

Three ways a session ends, all reaching the same place:

- `await session.close()` — explicit
- `break` out of a `for await (const result of session)` — leaving the loop closes the session,
  because a browser nobody is reading from is never what was meant
- the `signal` you passed to `watch()` aborting — for a watcher there is no single run to cut
  short, so the signal ends the session

Ordering is defined where it could otherwise race: a `close()` during a `restart()` waits for the
restart to land before releasing what it built, so `close()` resolving always means everything is
down. After it resolves, the [live objects](#the-live-objects--outside-semver) are closed handles —
reading them is not an error, using them is.

These return plain Promises rather than Tasks, deliberately: they are commands on a session that
already exists, so `void session.runAll()` from a keypress handler must actually start the run.

**`abort` vs `close` vs `signal`** — three different scopes, easy to mix up:

|                                        |                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `session.abort()`                      | cut the run in flight short; the session stays open and watching           |
| `session.restart()`                    | rebuild the machinery, keep the session; see below                         |
| `session.close()`                      | end the session: browser down, port released, iteration over               |
| `signal` on `watch()`                  | **closes** the session — for a watcher there is no single run to cut short |
| `signal` on `test()` / `openSession()` | aborts that one run, which is the whole session there                      |

### restart

Tears the machinery down — browser, page, server, watchers — boots it again, and runs the suite
once:

```js
const result = await session.restart();
```

For a change no rerun can see: an edited `package.json`, a plugin whose module you replaced, a
browser wedged by the page under test.

**The session survives.** It is the same object, and `events()` / `results()` stream straight
across — a restart is one transition in the life of a session, not a close followed by a new one.
If it ended the feeds it would be `close()` plus `watch()` with extra steps.

Four things to know:

- **`session.url` may change.** The port is released and reacquired; if something took it in
  between, the new server binds the next one. Re-read `url` rather than caching it.
- **The [live objects](#the-live-objects--outside-semver) are replaced — all but `esbuild`.**
  Re-read `browser`, `page`, `webServer` and `fileWatchers` after a restart instead of holding
  references across one. `esbuild` is deliberately kept: a restart reuses the same config, so a
  fresh context would hold the very same plugin objects, and disposing it only respawned esbuild's
  service child for nothing. `contextKey` still swaps the context out when build inputs change.
- **`initial` still names the run the session started with.** It is readonly and callers hold it;
  the restart's own run arrives through `results()` and `latest` like any other, and exactly once.
- **It takes the same queue reruns take.** A restart waits for an in-flight run, and a rerun asked
  for during one waits for the restart. Two concurrent `restart()` calls are one restart — both
  callers get the same result — and a `close()` during one waits for it to land.

`abort` is deliberately the platform's word: you hand in an `AbortSignal`, `signal.aborted` is
how the platform spells it, and a run cut short comes back as `result.status === 'aborted'` — one
idea, arriving from three directions.

Both feeds are **Streams**, so the combinators are already attached — no wrapper:

```js
// notify on the first red run, and stop watching for it
const [red] = await session
  .results()
  .filter((r) => !r.ok)
  .take(1)
  .collect();

// every event of every rerun, flat and in order — for progress bars and live logs
await session
  .events()
  .filter((e) => e.kind === 'test')
  .forEach(render);
```

`results()` is one complete `RunResult` per rerun; `events()` is the fine-grained view. The
session stays a _handle_ rather than being a Stream itself: combinators return new Streams, and
one with no `close()` would leave a browser with no owner.

### Reconfiguring a session — `restart(patch)`

`run(files)` narrows what _executes_ within the bundle the session already has. Nothing widens what
is _in_ it — the selection is fixed at `Config.setup`. `restart(patch)` is how a live session
changes its mind:

```js
await session.restart({ filter: 'Cart' }); // same session, different filter
await session.restart({ inputs: ['test/', 'e2e/'] }); // same session, wider scope
```

The session survives, exactly as a bare `restart()`: same object, `events()` and `results()`
streaming straight across. It's the operation a TUI needs behind a filter box or a scope picker,
and reconfiguring is the same act either way — rebuild, reboot.

Three things to know:

- **A patch that will not resolve leaves the session alone.** The new config is built _before_
  anything is torn down, so an input matching nothing rejects with the session still serving and
  still runnable, rather than half-demolished.
- **It gives up the warm esbuild context.** A bare `restart()` keeps it, because the same config
  would produce a context holding the very same plugin objects. A different file set has a
  different `contextKey`, so the bundler discards and rebuilds it — inherent to asking for a
  different bundle.
- **`reporter` / `reporters` and `signal` are not patchable**, and the type says so. Reporters are
  how this session's own feeds are attached, so replacing them would leave `results()` and
  `events()` open and permanently silent; `signal` belongs to the session's whole life rather than
  one boot of it.

### The page it serves

`session.url` stays up from `await watch(…)` until `close()` — the one verb that keeps a server
alive, so a script can hold it open and work alongside it. `test()` and `openSession()` both close
theirs when the run ends.

Two things to know before you open it:

- **It is a live QUnit page, not a report.** Loading it runs the suite again, in your browser.
  That does not corrupt the session — repeat `testEnd`s are deduplicated and no extra `RunResult`
  is emitted — but with a reporter attached you will see
  `# [qunitx] WARNING: duplicate testEnd ignored …` lines while you visit.
- **Your tab reloads on every rerun.** The server pushes `refresh` and the page reloads itself
  (the headless one ignores it and is navigated directly), so each save runs the suite twice over:
  once headless, once in your tab.

Watch also runs **one bundle, serially** — it never splits into concurrent groups, so
`result.groups.length` is always `1` and everything is served at `/` with no `/group-N` prefixes.
For a large suite that makes watch's first run slower than the same selection through `test()`.

### The live objects — outside semver

A watch session hands over its actual machinery, so you can do things this API has not thought of:

|                        | what it is                                                                |
| ---------------------- | ------------------------------------------------------------------------- |
| `session.browser`      | playwright-core `Browser`                                                 |
| `session.page`         | playwright-core `Page` — the tab the suite runs in                        |
| `session.webServer`    | this project's `HTTPServer`; `.get()` to add routes, `.publish()` to push |
| `session.esbuild`      | esbuild `BuildContext`, or `null` before the first build                  |
| `session.fileWatchers` | live `Record<path, FSWatcher>` of the per-path watchers                   |

```js
await session.page.screenshot({ path: 'suite.png' });
session.webServer.get('/api/user', (_request, response) => response.json({ id: 1 }));
Object.keys(session.fileWatchers); // what is currently being watched
```

> **These five are outside semver.** Three of them are types this project does not own —
> playwright-core's and esbuild's — and pinning their shape would make every upgrade of those a
> breaking change here. They may change or disappear in a **minor** release. Everything else on
> the session is the supported surface.

Two honest caveats. `esbuild` is genuinely `null` until the first build has created a context, so
check it rather than asserting. And `fileWatchers` is a **partial** view: the parent-directory
watchers, rescan intervals and symlink pollers the session also owns are not in it — it answers
"what is being watched", not "every handle the session holds".

## search

Lists what a selection would run, without running it — no browser, no bundle, milliseconds.

```js
import { search } from 'qunitx-cli';

const { matches, total, unlistable } = await search({ filter: 'Cart' });

matches.map((test) => `${test.fullName}  ${test.file}#${test.line}`);
unlistable.total; // declarations the scan could not name — see `.computedNames` / `.unparseable`
```

A non-zero `unlistable.total` means `total` is a lower bound: ``test(`case ${i}`)`` has no name
until the browser runs it.

## Daemon

Reuses a persistent browser and warm bundle across runs — worth roughly 800 ms per run once it is
up.

```js
import { Daemon } from 'qunitx-cli';

await Daemon.start();
const result = await Daemon.test({ inputs: ['test/'] }); // same RunResult
await Daemon.status(); // { running: true, pid, cwd, socketPath, … }
await Daemon.stop();
```

`Daemon.test` takes the options that survive a socket, so plugin objects and reporter instances are
a compile error rather than a silent drop. `console` still works — the daemon's text is streamed
back and written there.

## init / generate

```js
import { init, generate } from 'qunitx-cli';

const { written, skipped } = await init({ cwd: '/proj' }); // never overwrites
const { path, created } = await generate({ target: 'test/login-test.ts' });
```

## validate

Rejects options the runner will not accept, without launching anything. `test()` does this itself;
call it directly to check a set of options before committing to a run.

```js
import { validate, Failure } from 'qunitx-cli';

try {
  validate({ browser: 'netscape' });
} catch (error) {
  Failure.is(error); // true — code: 'InvalidOption'
}
```

## The result

```js
result.ok; // every test passed and nothing else went wrong
result.exitCode; // what the CLI would have exited with
result.counts; // { total, passed, failed, skipped, todo, assertionsFailed }
result.tests; // every test: name, modules, fullName, status, durationMs, assertions, file
result.failures; // the subset that failed — the list you usually want first
result.files; // absolute paths of the test files this run executed
result.failedFiles; // absolute paths, attributed through source maps
result.notices; // qunitx's own `# …` diagnostics, as data — see below
result.browserLogs; // console.* and uncaught errors from the page (newest 1000)
result.browserLogsDropped; // how many were dropped past that cap
result.coverage; // per-file line coverage, or null
result.junitXml; // the XML document, or null
result.durationMs;
result.startedAt; // epoch ms
result.finishedAt; //  ″
result.groups; // one entry per concurrent group: its files and its output directory
result.groups.length; // the concurrency the run used; 1 for watch and single-file runs
result.status; // 'completed' | 'aborted' | 'failFast' — see above
result.resolved; // { browser, projectRoot, output, port, extensions, coverageFormats, filter? }
```

`resolved` answers questions the caller cannot recover from what it passed in — chiefly which
browser ran, and which port was actually bound (it auto-increments past a busy one).

`file` on a test is populated **for failures only**: QUnit's `testEnd` carries no file, so the
path is recovered from the failing assertion's stack through the source map. A passing test leaves
no stack to map.

### `groups` — reproducing a failure that only happens in company

A run spreads its files across concurrent groups, and each group bundles its files into one page.
Tests in the same group therefore share globals and a DOM, which is where "passes alone, fails in
the suite" comes from. The split is recomputed every run from recorded timings and the core count,
so it is not stable and not something you can work out from the outside — `groups` is the only
record of it:

```js
const result = await test({ inputs: ['test/'] });
const suspect = result.failures[0];
const group = result.groups.find((one) => one.files.includes(suspect.file));

await test({ inputs: group.files }); // same bundle, on its own
await test({ inputs: [suspect.file] }); // just the one file — green here means co-bundling
```

`group.output` is where that group's bundle and artifacts were written, and it is still there
after the run. There is deliberately **no URL**: the group's server is closed by the time you hold
the result, so an address would be a dead link. To look at a page yourself, use the durable
artifact (`--open` opens exactly that `file://` path for a finished run) or keep a run alive with
[`watch()`](#watch), whose `url` points at a server that is genuinely still listening.

## Notices — why `ok` alone is not enough

`notices` are every `# …` line the CLI prints, as structured data. They matter because `ok` is
ambiguous on its own:

```js
const result = await test({ inputs: ['test/'], onlyFailed: true });
result.ok; // true
result.counts.total; // 0   ← nothing ran, and a gate checking `ok` would pass
result.notices; // [{ level: 'info',
//    message: 'qunitx --only-failed: no previously-failing test files to run' }]
```

Each carries a `level`: `info` (a decision qunitx made), `warning` (a surprise), `error` (also
went to stderr). So a cheap gate is `result.notices.some((n) => n.level !== 'info')`. Typical
ones: a filter that matched nothing, `--changed` narrowing the run, a line target superseded by a
broader input, coverage skipped on a non-chromium browser, build errors, timeouts.

They are _not_ captured stdout — text is a rendering **of** these, not their source.

## Custom reporters

A reporter is any object with the hooks it cares about. All five are optional.

```ts
import type { Reporter, ReporterContext, TestDetails } from 'qunitx-cli';

const mine: Reporter = {
  onRunStart(context: ReporterContext, info) {},
  onTestEnd(context: ReporterContext, details: TestDetails) {},
  onNotice(context: ReporterContext, notice) {}, // qunitx's own diagnostics
  onBrowserLog(context: ReporterContext, log) {}, // console.* from the page
  onRunEnd(context: ReporterContext, info) {}, // may return a Promise
};
```

`reporter` takes one, `reporters` takes several — passing both is an `InvalidOption`. Yours can
sit alongside a built-in:

```js
await test({ reporters: ['tap', mine] });
```

A reporter that throws costs its own output and nothing else — delivery isolates each one, so a
broken reporter never costs you the result.

Passing an **object** does not turn printing on; only naming a built-in does. So a collector of
your own keeps the run silent.

### What a hook receives

`ReporterContext` — deliberately _not_ the run's config, which would hand third-party code the
mutable state of the run it is reporting on:

```ts
context.console; // where to write — see below
context.counts; // the run's LIVE totals (the same object the runner updates)
context.projectRoot; // absolute, for rendering paths relative to it
context.output; // absolute build output directory
context.junit; // `--junit`'s value, when set
context.sourceMapDecoder; // maps a bundle frame back to source, once the run has one
context.daemon; // is this run inside the persistent daemon
```

To watch a run with the _public_ shapes — `TestResult`, `Notice`, `BrowserLog` — use
`openSession().events()` instead; the reporter hooks carry QUnit's own payloads.

## Tutorial: a nyan cat reporter

The complete, runnable version is
[`examples/nyan-reporter.ts`](../examples/nyan-reporter.ts) — `node examples/nyan-reporter.ts`.
It draws a rainbow that grows one segment per finished test, with the cat riding the end of it.

**1. One segment per test.** `onTestEnd` gets QUnit's `TestDetails`, so the outcome is a lookup:

```ts
function segment(status: TestDetails['status']): string {
  if (status === 'failed') return paint(31, '!');
  else if (status === 'skipped' || status === 'todo') return paint(90, '·');

  return '-';
}
```

**2. Draw through `context.console`, never `process.stdout`.** That indirection is what lets the
same reporter be silenced, or captured into a buffer, without changing it:

```ts
onTestEnd(context: ReporterContext, details: TestDetails): void {
  trail.push(segment(details.status));
  const rows = RAINBOW.map((colour, row) => {
    const stripe = paint(colour, trail.slice(Math.max(0, row - 2)).join(''));
    return `  ${stripe}${row === 3 ? paint(93, CAT[trail.length % 2]) : ''}`;
  });
  context.console.log(`${rows.join('\n')}\n\x1b[6A`); // redraw in place
}
```

**3. The totals are already there.** `context.counts` is the live counter, so at `onRunEnd` it is
final — there is nothing to tally yourself:

```ts
onRunEnd(context: ReporterContext, info): void {
  const { total, passed, failed } = context.counts;
  const verdict = failed > 0 ? paint(31, 'nyan is sad') : paint(32, 'nyan is happy');
  context.console.log(`\x1b[6B\n  ${verdict} — ${passed}/${total} passed in ${info.durationMs}ms\n`);
}
```

**4. Use it.** Printing and answering are separate concerns, so the result comes back regardless
of what the reporter did with it:

```js
const result = await test({ inputs: ['test/'], reporter: nyanReporter() });
process.exitCode = result.ok ? 0 : 1;
```

## Where output goes

Every reporter line and the TAP document itself go through the run's `Console` — `{ log, error }`,
the same two channels the global has. That is what makes "run these tests and print nothing"
expressible, and what lets you point the built-in reporters at a buffer:

```js
import { test, streamConsole, silentConsole, processConsole } from 'qunitx-cli';

const chunks = [];
await test({
  inputs: ['test/'],
  reporter: 'tap',
  console: streamConsole({ write: (text) => chunks.push(text) }),
});
```

Default: `processConsole` when a reporter is **named**, `silentConsole` otherwise. Severity is not
here — that is `Notice.level`; `error` means the stderr stream, exactly as `console.error` does.

## Errors

Declared failures are discriminable values, not messages to parse.

```js
import { test, Failure } from 'qunitx-cli';

const outcome = await test({ browser: 'netscape' }).result(); // never throws
if (Failure.is(outcome)) {
  outcome.code; // 'InvalidOption'
  Failure.format(outcome); // 'Invalid `browser` value: "netscape". Expected one of …'
}
```

`await test(…)` throws the same failure instead, if you prefer `try`/`catch`. `Failure.hasCode(x,
'InvalidOption', 'ProjectRootNotFound')` narrows to a specific set, for handling some and
rethrowing the rest.

A runnable end-to-end example lives in
[`examples/js-api-quality-gate.ts`](../examples/js-api-quality-gate.ts) — search, run, coverage
floor, JUnit, a custom reporter, and failure handling in one script.

## Deno, JSR and types

From JSR:

```ts
import { test } from 'jsr:@izelnakri/qunitx-cli/api';
```

The package also ships its TypeScript sources on npm, so Deno and Node 24 can import them
directly:

```ts
import { test } from 'qunitx-cli/lib/api/index.ts';
```

Types are shipped for the bundled entry too — `import { test, type RunResult } from 'qunitx-cli'`
typechecks under `--strict`.
