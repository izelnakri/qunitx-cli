/**
 * # QUnitX CLI
 *
 * **Your QUnit tests, in a real browser, from one command.** `qunitx` bundles the files you point
 * it at, runs them in headless Chrome, and streams TAP back to your terminal. No karma, no
 * webpack, no config file.
 *
 * ## Install
 *
 * ```sh
 * deno install -Agf jsr:@izelnakri/qunitx-cli
 * ```
 *
 * One command on every platform: this module resolves your os/arch at run time and caches the
 * matching prebuilt binary under `~/.cache/qunitx/`, so nothing is compiled and nothing is
 * per-target. On npm it is `npm install -g qunitx-cli` instead.
 *
 * ## Write a test
 *
 * Plain QUnit — the same file runs under `node --test` and `deno test` too:
 *
 * ```js
 * // math-test.js
 * import { module, test } from 'qunitx';
 *
 * module('Math', () => {
 *   test('addition', (assert) => {
 *     assert.equal(2 + 2, 4);
 *   });
 *
 *   test('deepEqual understands Sets', (assert) => {
 *     assert.deepEqual(new Set(['js']), new Set(['js']));
 *   });
 * });
 * ```
 *
 * ## Run it
 *
 * ```sh
 * $ qunitx                     # no arguments: every input form and flag, at a glance
 * $ qunitx math-test.js        # one file, in a real browser
 * TAP version 13
 * # Running 1 test file across 1 group
 * # QUnitX running: http://localhost:1234/
 * ok 1 Math | addition # (2 ms)
 * ok 2 Math | deepEqual understands Sets # (1 ms)
 *
 * 1..2
 * # tests 2
 * # pass 2
 * # fail 0
 * # duration 414
 * ```
 *
 * Point it at whatever you have: a file, a folder (`qunitx test/`), a glob (`qunitx 'test/**'`),
 * or `qunitx test/cart-test.js#34` to run only the test declared on that line. `--filter`,
 * `--reporter=spec`, `--coverage`, `--junit`, `--failFast` and `--browser=firefox|webkit` are all
 * listed by the bare `qunitx` above.
 *
 * ## The QUnit UI
 *
 * `--watch` leaves the web server up, so the same run is also a page you can open, filter and
 * re-run by hand while it rebuilds on every save:
 *
 * ```sh
 * $ qunitx 'tests/**' --watch
 * # QUnitX running: http://localhost:1234/
 * TAP version 13
 * ok 1 Math | addition # (2 ms)
 * ok 2 Math | deepEqual understands Sets # (1 ms)
 *
 * 1..2
 * # tests 2
 * # pass 2
 * # fail 0
 *
 * # Watching files... You can browse the tests on http://localhost:1234 ...
 * # Shortcuts: Press "qq" to abort running tests, "qa" to run all the tests, "qf" to run last failing test, "ql" to repeat last test
 * ```
 *
 * ## The JS/TS API
 *
 * Everything above is also a library, under the `./api` entrypoint — results come back as values
 * and nothing ever calls `process.exit` on your behalf. Node and Bun import it as `'qunitx-cli'`;
 * from Deno it is `'jsr:@izelnakri/qunitx-cli/api'`. Four examples follow; the
 * [full API guide](https://github.com/izelnakri/qunitx-cli/blob/main/docs/javascript-api.md)
 * documents every verb.
 *
 * Run a suite and read the result:
 *
 * ```js
 * // run-tests.js
 * import { test } from 'qunitx-cli';
 *
 * const result = await test('tests/');
 *
 * console.log(`${result.counts.passed}/${result.counts.total} passed in ${result.durationMs}ms`);
 * for (const failed of result.failures) {
 *   console.log(`FAILED ${failed.fullName} (${failed.file})`);
 * }
 *
 * process.exitCode = result.ok ? 0 : 1;
 *
 * // $ node run-tests.js
 * // 2/2 passed in 377ms
 * ```
 *
 * Run ONE file as a plain script in the browser — no QUnit, no TAP. This is what `run` means;
 * the suite verb above is `test`:
 *
 * ```js
 * // seed.js
 * import { run } from 'qunitx-cli';
 *
 * const result = await run('scripts/seed.ts');
 *
 * console.log(`exit ${result.exitCode} after ${result.durationMs}ms`);
 *
 * process.exitCode = result.exitCode;
 *
 * // $ node seed.js
 * // seeded 3 rows into seeding
 * // exit 0 after 1024ms
 * ```
 *
 * Ask what a filter would match, without running anything — no browser is launched:
 *
 * ```js
 * // search-report-tests.js
 * import { search } from 'qunitx-cli';
 * import { relative } from 'node:path';
 *
 * const report = await search({ inputs: ['tests/'], filter: 'deepEqual' });
 *
 * console.log(`${report.matches.length} of ${report.total} tests match, in ${report.files} files`);
 * for (const match of report.matches) {
 *   console.log(`  ${match.fullName} — ${relative(process.cwd(), match.file)}:${match.line}`);
 * }
 *
 * // $ node search-report-tests.js
 * // 1 of 2 tests match, in 1 files
 * //   Math: deepEqual understands Sets — tests/math-test.js:8
 * ```
 *
 * Or hold a watch session open: the server stays reachable and the suite keeps re-running while
 * your script does other work, until you close it.
 *
 * ```js
 * // watch-few-seconds.js
 * import { watch } from 'qunitx-cli';
 *
 * const session = await watch('tests/');
 * console.log(`QUnit UI on ${session.url} — ${session.initial.counts.passed} passed`);
 *
 * const response = await fetch(session.url);
 * console.log(`the server answers while the script works: ${response.status}`);
 *
 * setTimeout(() => session.close(), 5000);
 *
 * // Ask for a rerun without touching a file. It lands on the iteration below exactly as a save
 * // would, so a script drives the suite on its own terms — and `runFailed()` / `runAll()` too.
 * await session.run();
 *
 * for await (const result of session) {
 *   console.log(`ran: ${result.counts.passed}/${result.counts.total} passed`);
 * }
 * console.log('closed — the browser and the port are released');
 *
 * // $ node watch-few-seconds.js
 * // QUnit UI on http://localhost:1234 — 2 passed
 * // the server answers while the script works: 200
 * // ran: 2/2 passed        <- the first run
 * // ran: 2/2 passed        <- the rerun above
 * // closed — the browser and the port are released
 * ```
 *
 * `openSession` (a run you can watch event-by-event as it happens), `search`, `init`, `generate`,
 * the daemon controls and the reporter interface are all covered in the
 * [JavaScript / TypeScript API guide](https://github.com/izelnakri/qunitx-cli/blob/main/docs/javascript-api.md),
 * with the generated reference on the
 * [`./api`](https://jsr.io/@izelnakri/qunitx-cli/doc/api) entrypoint.
 *
 * ## About this module
 *
 * This entrypoint is the launcher, not the runner: on first use it fetches the prebuilt binary and
 * esbuild sidecar for this package's version from the matching GitHub release, caches them under
 * `~/.cache/qunitx/<version>/<target>/`, then spawns the binary with stdio inherited and forwards
 * its exit code. Later runs go straight to the spawn. The cache is keyed on the published JSR
 * version rather than the newest release, so two launchers pinned to different versions never race
 * over the same file on disk.
 *
 * @module
 */

// The doc above is the JSR package page itself (the package is set to readmeSource: jsdoc), so it
// is worth more care than a normal comment — and being a block comment, no example in it may
// contain the two characters that end one. That is why the globs read `'test/**'`: escaping the
// recursive form would leave a literal backslash inside the fence and break copy-paste.
import denoJson from './deno.json' with { type: 'json' };

const REPO = 'izelnakri/qunitx-cli';
const VERSION = `v${denoJson.version}`;

interface Target {
  archive: string;
  bin: string;
  isZip: boolean;
}

// Keys are `${Deno.build.os}-${Deno.build.arch}` (see platformKey below).
// Every entry MUST have a matching artifact published by the build-deno-binaries
// job in .github/workflows/ci.yml — adding a target here without a release
// runner produces a 404 for users on that platform.
const TARGETS: Record<string, Target> = {
  'linux-x86_64': { archive: 'qunitx-deno-linux-x64.tar.gz', bin: 'qunitx', isZip: false },
  'linux-aarch64': { archive: 'qunitx-deno-linux-arm64.tar.gz', bin: 'qunitx', isZip: false },
  'darwin-aarch64': { archive: 'qunitx-deno-macos-arm64.tar.gz', bin: 'qunitx', isZip: false },
  'windows-x86_64': { archive: 'qunitx-deno-windows-x64.zip', bin: 'qunitx.exe', isZip: true },
  'windows-aarch64': { archive: 'qunitx-deno-windows-arm64.zip', bin: 'qunitx.exe', isZip: true },
};

const platformKey = `${Deno.build.os}-${Deno.build.arch}`;
const target = TARGETS[platformKey];
if (!target) {
  console.error(`qunitx-cli: no prebuilt binary for ${platformKey}`);
  Deno.exit(1);
}

const home = Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE');
if (!home) {
  console.error('qunitx-cli: cannot determine home directory (HOME/USERPROFILE unset)');
  Deno.exit(1);
}

// Per-OS cache root: %LOCALAPPDATA% on Windows (the documented place for
// app-managed caches), $XDG_CACHE_HOME or ~/.cache elsewhere. Without the
// Windows branch the binary lands under C:\Users\foo\.cache\qunitx — works,
// but surprises anyone inspecting %LOCALAPPDATA% to find it.
const cacheRoot =
  Deno.build.os === 'windows'
    ? (Deno.env.get('LOCALAPPDATA') ?? `${home}/AppData/Local`)
    : (Deno.env.get('XDG_CACHE_HOME') ?? `${home}/.cache`);
const cacheDir = `${cacheRoot}/qunitx/${denoJson.version}/${platformKey}`;
const binPath = `${cacheDir}/${target.bin}`;

let binStat: Deno.FileInfo | null = null;
try {
  binStat = await Deno.stat(binPath);
} catch (err) {
  if (!(err instanceof Deno.errors.NotFound)) throw err;
}

if (!binStat) {
  await downloadAndExtract();
}

// Spawn the cached binary with stdio inherited and forward its exit code.
// We use Deno.Command (not node:child_process) since this bootstrap is
// Deno-only by design — the JSR install flow targets `deno install`.
const child = new Deno.Command(binPath, {
  args: Deno.args,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
}).spawn();
const status = await child.status;
Deno.exit(status.code);

async function downloadAndExtract(): Promise<void> {
  const url = `https://github.com/${REPO}/releases/download/${VERSION}/${target.archive}`;
  console.error(`qunitx-cli: fetching ${VERSION} prebuilt binary`);
  console.error(`  ${url}`);

  await Deno.mkdir(cacheDir, { recursive: true });

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`qunitx-cli: download failed (${res.status} ${res.statusText})`);
    Deno.exit(1);
  }

  // Stage extraction in a sibling tmp dir so a failed extract doesn't leave a
  // half-populated cacheDir behind that the next run would mistake for a hit.
  const stageDir = `${cacheDir}.tmp-${crypto.randomUUID()}`;
  await Deno.mkdir(stageDir, { recursive: true });

  try {
    const archivePath = `${stageDir}/${target.archive}`;
    await Deno.writeFile(archivePath, new Uint8Array(await res.arrayBuffer()));
    await extract(archivePath, stageDir, target.isZip);
    // The archive layout is qunitx-deno-<target>/{qunitx[.exe], esbuild[.exe]}.
    const inner = `${stageDir}/${target.archive.replace(/\.(tar\.gz|zip)$/, '')}`;
    for await (const entry of Deno.readDir(inner)) {
      const dest = `${cacheDir}/${entry.name}`;
      await Deno.rename(`${inner}/${entry.name}`, dest);
      if (Deno.build.os !== 'windows') await Deno.chmod(dest, 0o755);
    }
  } finally {
    await Deno.remove(stageDir, { recursive: true }).catch(() => {});
  }
}

async function extract(archivePath: string, dest: string, isZip: boolean): Promise<void> {
  // Shell out to system tar / unzip rather than pulling a JS extractor — the
  // bootstrap stays small (one fetch + one spawn) and the host always has these
  // binaries on every supported target (tar on POSIX, unzip is preinstalled on
  // macOS and added to Git Bash; Windows users running the JSR launcher have
  // PowerShell's Expand-Archive as a fallback if unzip is absent — handled below).
  if (isZip) {
    const unzip = new Deno.Command('unzip', { args: ['-q', archivePath, '-d', dest] });
    const status = await unzip.spawn().status.catch(() => null);
    if (!status?.success) {
      // PowerShell fallback for Windows shells that don't ship unzip on PATH.
      const ps = new Deno.Command('powershell', {
        args: [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Path '${archivePath}' -DestinationPath '${dest}' -Force`,
        ],
      });
      const psStatus = await ps.spawn().status;
      if (!psStatus.success)
        throw new Error('extract failed: unzip and Expand-Archive both failed');
    }
  } else {
    const tar = new Deno.Command('tar', { args: ['xzf', archivePath, '-C', dest] });
    const status = await tar.spawn().status;
    if (!status.success) throw new Error('tar extract failed');
  }
}
