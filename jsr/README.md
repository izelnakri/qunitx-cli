# QUnitX CLI

**Your QUnit tests, in a real browser, from one command.** `qunitx` bundles the files you point it
at, runs them in headless Chrome, and streams TAP back to your terminal. No karma, no webpack, no
config file.

## Install

```sh
deno install -Agf jsr:@izelnakri/qunitx-cli
```

One command on every platform: the launcher resolves your os/arch at run time and caches the
matching prebuilt binary under `~/.cache/qunitx/`, so nothing is compiled and nothing is per-target.
On npm it is `npm install -g qunitx-cli` instead.

## Write a test

Plain QUnit — the same file runs under `node --test` and `deno test` too:

```js
// math-test.js
import { module, test } from 'qunitx';

module('Math', () => {
  test('addition', (assert) => {
    assert.equal(2 + 2, 4);
  });

  test('deepEqual understands Sets', (assert) => {
    assert.deepEqual(new Set(['js']), new Set(['js']));
  });
});
```

## Run it

```sh
$ qunitx                     # no arguments: every input form and flag, at a glance
$ qunitx math-test.js        # one file, in a real browser
TAP version 13
# Running 1 test file across 1 group
# QUnitX running: http://localhost:1234/
ok 1 Math | addition # (2 ms)
ok 2 Math | deepEqual understands Sets # (1 ms)

1..2
# tests 2
# pass 2
# fail 0
# duration 414
```

Point it at whatever you have: a file, a folder (`qunitx test/`), a glob (`qunitx 'test/**'`), or
`qunitx test/cart-test.js#34` to run only the test declared on that line. `--filter`,
`--reporter=spec`, `--coverage`, `--junit`, `--failFast` and `--browser=firefox|webkit` are all
listed by the bare `qunitx` above.

## The QUnit UI

`--watch` leaves the web server up, so the same run is also a page you can open, filter and re-run
by hand while it rebuilds on every save:

```sh
$ qunitx 'tests/**' --watch
# QUnitX running: http://localhost:1234/
TAP version 13
ok 1 Math | addition # (2 ms)
ok 2 Math | deepEqual understands Sets # (1 ms)

1..2
# tests 2
# pass 2
# fail 0

# Watching files... You can browse the tests on http://localhost:1234 ...
# Shortcuts: Press "qq" to abort running tests, "qa" to run all the tests, "qf" to run last failing test, "ql" to repeat last test
```

## The JS/TS API

Everything above is also a library, under the `./api` entrypoint — results come back as values and
nothing ever calls `process.exit` on your behalf. Node and Bun import it as `'qunitx-cli'`; from
Deno it is `'jsr:@izelnakri/qunitx-cli/api'`. Four examples follow; the
[full API guide](https://github.com/izelnakri/qunitx-cli/blob/main/docs/javascript-api.md)
documents every verb.

Run a suite and read the result:

```js
// run-tests.js
import { test } from 'qunitx-cli';

const result = await test('tests/');

console.log(`${result.counts.passed}/${result.counts.total} passed in ${result.durationMs}ms`);
for (const failed of result.failures) {
  console.log(`FAILED ${failed.fullName} (${failed.file})`);
}

process.exitCode = result.ok ? 0 : 1;

// $ node run-tests.js
// 2/2 passed in 377ms
```

Run ONE file as a plain script in the browser — no QUnit, no TAP. This is what `run` means; the
suite verb above is `test`:

```js
// seed.js
import { run } from 'qunitx-cli';

const result = await run('scripts/seed.ts');

console.log(`exit ${result.exitCode} after ${result.durationMs}ms`);

process.exitCode = result.exitCode;

// $ node seed.js
// seeded 3 rows into seeding
// exit 0 after 1024ms
```

Ask what a filter would match, without running anything — no browser is launched:

```js
// search-report-tests.js
import { search } from 'qunitx-cli';
import { relative } from 'node:path';

const report = await search({ inputs: ['tests/'], filter: 'deepEqual' });

console.log(`${report.matches.length} of ${report.total} tests match, in ${report.files} files`);
for (const match of report.matches) {
  console.log(`  ${match.fullName} — ${relative(process.cwd(), match.file)}:${match.line}`);
}

// $ node search-report-tests.js
// 1 of 2 tests match, in 1 files
//   Math: deepEqual understands Sets — tests/math-test.js:8
```

Or hold a watch session open: the server stays reachable and the suite keeps re-running while your
script does other work, until you close it.

```js
// watch-few-seconds.js
import { watch } from 'qunitx-cli';

const session = await watch('tests/');
console.log(`QUnit UI on ${session.url} — ${session.initial.counts.passed} passed`);

const response = await fetch(session.url);
console.log(`the server answers while the script works: ${response.status}`);

setTimeout(() => session.close(), 5000);

// Ask for a rerun without touching a file. It lands on the iteration below exactly as a save
// would, so a script drives the suite on its own terms — and `runFailed()` / `runAll()` too.
await session.run();

for await (const result of session) {
  console.log(`ran: ${result.counts.passed}/${result.counts.total} passed`);
}
console.log('closed — the browser and the port are released');

// $ node watch-few-seconds.js
// QUnit UI on http://localhost:1234 — 2 passed
// the server answers while the script works: 200
// ran: 2/2 passed        <- the first run
// ran: 2/2 passed        <- the rerun above
// closed — the browser and the port are released
```

`openSession` (a run you can watch event-by-event as it happens), `init`, `generate`, the daemon
controls and the reporter interface are all covered in the
[JavaScript / TypeScript API guide](https://github.com/izelnakri/qunitx-cli/blob/main/docs/javascript-api.md),
with the generated reference on the
[`./api`](https://jsr.io/@izelnakri/qunitx-cli/doc/api) entrypoint.

## About this package

The JSR entrypoint is a launcher, not the runner: on first use it downloads the prebuilt binary for
this package's version from the matching GitHub release, caches it, and spawns it with stdio
inherited. `deno run jsr:@izelnakri/qunitx-cli/cli.ts` would re-evaluate the source graph on every
run, which is slower than the `deno compile`d binary — this gives Deno users the fast-start path
without unpacking a tarball by hand. Without Deno, the same effect:

```sh
curl -fsSL https://raw.githubusercontent.com/izelnakri/qunitx-cli/main/install.sh | sh
```

**Supported targets**: linux-x64, linux-arm64, macos-arm64, windows-x64, windows-arm64 — the same
matrix as the [GitHub Releases](https://github.com/izelnakri/qunitx-cli/releases). Anything else
exits non-zero with a clear message.

**Cache location**: `$XDG_CACHE_HOME/qunitx/<version>/<target>/` (default `~/.cache/qunitx/...`) on
Linux and macOS, `%LOCALAPPDATA%\qunitx\<version>\<target>\` on Windows. Each entry is keyed on the
published version, so two launchers pinned to different versions never race over the same file.
Delete the version subdirectory to force a re-download.
