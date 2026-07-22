/**
 * Unified test entrypoint: setup → semaphore server → run tests → exit.
 *
 * The Chrome semaphore server lives in this process (not detached), so it is automatically
 * cleaned up when the test run finishes. Its port is forwarded to all test worker threads
 * via the QUNITX_SEMAPHORE_PORT environment variable.
 *
 * Three-phase execution:
 *   Phase 1 — fast suite: all *-test.ts except watch-rerun. These complete in seconds.
 *   Phase 2 — watch-rerun suite: runs alone so its 17 long-lived Chrome slots (17–37 s each)
 *              don't starve Phase 1 tests. Without this separation, Phase 1 tests spend
 *              35–57 s waiting in the semaphore queue despite taking only ~2 s to execute.
 *   Phase 3 — leak tests (*-leak.ts): isolated after a sweep so they see clean /proc + /tmp.
 *
 * The semaphore is a throttle ceiling, not a speedup mechanism. Tests run with
 * { concurrency: true } so they all fire in parallel; the semaphore caps concurrent
 * Chrome instances at availableParallelism() to keep the queue full and busy without
 * overloading the machine. This gives predictable, fast runtimes on both CI (2 CPUs)
 * and dev machines (8+ CPUs) without hardcoded limits.
 */
import fs from 'node:fs/promises';
import os, { availableParallelism } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createSemaphoreServer } from './helpers/semaphore-server.ts';
import { killProcessGroup } from '../lib/utils/kill-process-group.ts';
import * as Chrome from '../lib/chrome/index.ts';
import { PER_TEST_TIMEOUT_MS } from './helpers/per-test-timeout.ts';
import { joinRunnerRegistry } from './helpers/runner-registry.ts';

// When invoked as `deno run -A test/runner.ts ...` (CI deno lanes), we spawn
// `deno test` workers instead of `node --test`. Detection is one runtime
// check; everything downstream branches off this flag so the same file drives
// both lanes without a parallel runner-deno.ts.
const IS_DENO = typeof (globalThis as { Deno?: { execPath(): string } }).Deno !== 'undefined';
const DENO_EXEC = IS_DENO ? (globalThis as { Deno: { execPath(): string } }).Deno.execPath() : '';

// Project-local V8 compile-cache dir for spawned workers and the cli.ts
// processes the test files invoke. Sits under node_modules/.cache (npm
// convention, gitignored, survives `rm -rf tmp/`, outside the leak-test sweep
// which only scans qunitx-chrome-* under os.tmpdir()). The runner itself
// doesn't enable compile cache — its module graph is small and doing so would
// pollute process.env, overriding the project-local default below.
const COMPILE_CACHE_DIR = path.resolve('node_modules/.cache/qunitx/v8');

const watchMode = process.argv.includes('--watch');
// --watch is never mixed with explicit file paths (see package.json scripts), so when
// it is present there are no explicit files; slice(2) is the file list otherwise.
const cliFiles = watchMode ? [] : process.argv.slice(2);

// Concurrent Chrome cap. Default = availableParallelism so the semaphore matches
// the runner's CPU budget. Lowered to 2 in three combinations where browser
// startup contention reliably manifests on hosted CI runners and a 250-ms
// stagger experiment failed to recover them (cd31f12 → Windows test-deno
// hit the same 25-min timeout, macos webkit's watch-mode bundle-error test
// still flaked):
//
//   * Windows under Deno: deno-compile cli binary (~190 MB embedded VFS)
//     cold-starts slowly on Windows (no page-cache between invocations the
//     way POSIX has). N=4 parallel cli cold-starts each spawning Chrome
//     deadlock the runner — multiple test files stall together at the start
//     of the browser phase and the suite never recovers, hitting the 25-min
//     job timeout. The root cause behaves like resource exhaustion (file
//     handles / ports) rather than a timing burst, so spacing launches isn't
//     sufficient — concurrency itself has to drop.
//
//   * macOS + webkit: the watch-mode "build error in watch mode ..." tests
//     intermittently stall on the post-fix page.reload() — a webkit-page-
//     lifecycle bug after a hung /tests.js request, not a cold-start race.
//     Halving parallel pressure removes the stall without serializing the
//     whole lane.
//
//   * Windows + firefox: inputs/{no-html,custom-html}-test.ts used to lose
//     --browser forwarding by hand-rolling their spawns, so this lane quietly
//     ran them on chromium. Routing them back through the shell helper made
//     them genuinely launch firefox — four concurrent instances between them —
//     and the lane stopped absorbing it: unrelated files (inputs/jsx-test.ts)
//     began failing on `page.goto: Timeout 60000ms exceeded` against a server
//     that had already bound its port. Firefox on Windows is simply heavier
//     per instance than the chromium these tests were accidentally using.
//
// All three caps are removable once the upstream platforms stabilize (see also
// the windows/webkit exclude in browser-compat.yml and the daemon-on-Windows
// skip in test/commands/daemon-test.ts — same root family).
const CHROME_CAP = isContentionLane()
  ? Math.min(2, availableParallelism())
  : availableParallelism();

function isContentionLane(): boolean {
  if (process.platform === 'win32' && IS_DENO) return true;
  if (process.platform === 'darwin' && process.env.QUNITX_BROWSER === 'webkit') return true;
  if (process.platform === 'win32' && process.env.QUNITX_BROWSER === 'firefox') return true;
  return false;
}

// Joining the registry, starting the semaphore server, and discovering test files are all
// independent — run them concurrently to cut startup time.
//
// The tmp/ wipe happens inside joinRunnerRegistry, and only when no other runner is live: tmp/
// is shared, so wiping it while another run is using it deletes that run's fixtures mid-flight
// (see the helper for why the mutex, not just the check, is what makes this safe). Solo runs —
// the overwhelmingly common case — behave exactly as before. tmp/ is recreated below so
// node:test can open the per-phase perf-reporter destination on phase 1 spawn.
const [runner, semaphore, [fastFiles, watchReruns, leakFiles]] = await Promise.all([
  joinRunnerRegistry(() => fs.rm('./tmp', { recursive: true, force: true })),
  createSemaphoreServer(CHROME_CAP),
  cliFiles.length > 0
    ? Promise.resolve([cliFiles, [], []] as [string[], string[], string[]])
    : Promise.all([
        // *-test.ts (excluding watch-rerun) — fast suite, runs concurrently.
        // watch-rerun-test.ts  — slow suite; runs alone in Phase 2 so its 17 long-lived
        //                        Chrome slots don't starve Phase 1 tests.
        // *-leak.ts  — isolation tests; must run after the main suite + sweep because they
        //              check global state (/tmp dirs, /proc) and would see false orphans
        //              from concurrent watch-mode tests that legitimately SIGKILL node-cli.
        // test/fixtures/** are inputs tests hand to the CLI — the coverage fixture is bundled
        // for the browser by flags/coverage-test.ts — not node:test files; running one as a
        // test crashes the worker on `import 'qunitx'`. The -test.ts suffix is part of the
        // fixture's realism, so exclude by location rather than renaming it.
        Array.fromAsync(fs.glob('test/**/*-test.ts')).then((files) =>
          files.filter((f) => !f.includes('watch-rerun') && !/(^|[\\/])fixtures[\\/]/.test(f)),
        ),
        Array.fromAsync(fs.glob('test/**/watch-rerun-test.ts')),
        Array.fromAsync(fs.glob('test/**/*-leak.ts')),
      ]),
]);
await fs.mkdir('./tmp', { recursive: true });

// Scopes this run's artifacts. Concurrent runners must not clobber each other's reporter
// output; CI globs tmp/junit-*.xml, so the extra segment still matches.
const RUN_ID = runner.runId;

type PerfEntry = {
  name: string;
  file: string;
  ms: number;
  kind: string;
  nesting: number;
  status?: 'pass' | 'fail';
  error?: string;
};

// pathToFileURL is required on Windows: an absolute path like
// `D:\a\qunitx-cli\test\helpers\ci-test-summary-reporter.ts` is parsed by Node's
// ESM loader as a URL with protocol `d:`, which it rejects (ERR_UNSUPPORTED_ESM_URL_SCHEME).
// pathToFileURL emits `file:///D:/a/.../reporter.ts` on Windows and `file:///path/...` on POSIX.
const REPORTER_PATH = pathToFileURL(path.resolve('test/helpers/ci-test-summary-reporter.ts')).href;
// Preload imported into every `node --test` worker. Two responsibilities:
// (1) widens util.inspect defaults so the spec-reporter shows full failure
// actuals, (2) annotates worker stderr on process.exit/uncaught/unhandled-
// rejection events so future "silent worker death" failures (where node:test
// renders the whole file as a single `'test failed'` with no further context —
// observed on test (windows-latest) for watch-rerun-test.ts in CI run
// 26037993172) are diagnosable from the job log alone. See the file's
// leading comment for details.
const WORKER_PRELOAD = pathToFileURL(path.resolve('test/helpers/test-worker-preload.ts')).href;
// Deno lane's equivalent of node's --test-timeout: preloaded into every test worker so it can
// wrap Deno.test with PER_TEST_TIMEOUT_MS. See test/helpers/deno-test-timeout.ts for why this
// has to be a preload rather than a flag.
const DENO_TEST_TIMEOUT_PRELOAD = pathToFileURL(
  path.resolve('test/helpers/deno-test-timeout.ts'),
).href;
const phaseResults: Array<{
  name: string;
  slug: string;
  durationMs: number;
}> = [];

// Phase 1: fast suite — all tests except watch-rerun (concurrent)
const exitCode1 = await runPhase('Fast suite', 'fast', fastFiles);

// Sweep between phases: kill Chrome orphaned by SIGKILL'd watch-test.ts children before
// Phase 2 runs, so orphans from Phase 1 don't inflate the Phase 3 leak-test counts.
await sweepOrphanedChrome();

// Phase 2: watch-rerun suite — runs alone so its long-lived Chrome slots don't starve
// Phase 1 tests. Skipped in watch mode (watch-rerun tests are not meaningful there).
const exitCode2 =
  !watchMode && watchReruns.length > 0
    ? await runPhase('Watch-rerun', 'watch-rerun', watchReruns)
    : 0;

// Sweep again: kill Chrome orphaned by the watch-rerun tests (SIGKILL'd on grace-period
// timeout) before the leak tests inspect /tmp and /proc.
await sweepOrphanedChrome();

// Phase 3: resource-leak tests, isolated after both sweeps so they see a clean state.
// Skipped in watch mode — interactive, and leak tests are not meaningful there.
const exitCode3 =
  !watchMode && leakFiles.length > 0 ? await runPhase('Leak tests', 'leak', leakFiles) : 0;

// End-of-run summary + junit XML generation. Skipped in watch mode (no end-of-run).
// Always prints the summary to stdout (visible locally and in CI logs); additionally
// appends the same markdown to $GITHUB_STEP_SUMMARY when set.
//
// Node lane: derive a rich summary from the per-test perf JSONL (slowest test / file /
// group). The same data also feeds writeJunitFromPerf() for dorny consumption.
// Deno lane: junit XML is written directly by `deno test --junit-path=` (no JSONL
// produced — Deno has only one reporter slot and we're using --reporter=pretty for
// stdout). Without per-test perf data, the rich breakdown isn't reconstructable from
// junit alone (deno's junit duplicates testcases as steps under the qunitx-internal
// path; trying to mine slowest-test from that is misleading). The Deno branch falls
// back to a phase-totals summary — the per-OS wall-clock comparison the user wants
// is still right there, and the test names + durations remain visible in the live
// pretty output above.
if (!watchMode) {
  const fmt = (ms: number): string =>
    ms >= 60_000
      ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
      : `${(ms / 1000).toFixed(1)}s`;
  let totalMs = 0;
  for (const p of phaseResults) totalMs += p.durationMs;

  let summary: string;
  if (IS_DENO) {
    const rows = phaseResults.map((p) => `| ${p.name} | ${fmt(p.durationMs)} |`).join('\n');
    summary =
      `## qunitx-cli test results (deno)\n\n` +
      `| phase | duration |\n|---|---|\n${rows}\n` +
      `| **total** | **${fmt(totalMs)}** |\n\n` +
      `_Per-test breakdown is in the live \`deno test --reporter=pretty\` output above; ` +
      `junit XML is written to \`tmp/junit-<run>-<phase>.xml\` for dorny._\n`;
  } else {
    // Read perf JSONL per phase, generate junit XML alongside (consumed by
    // .github/workflows/test-report.yml → dorny). Reading and writing in parallel.
    const perfByPhase = await Promise.all(
      phaseResults.map(async (p) => {
        const entries = await readPerf(`./tmp/perf-${RUN_ID}-${p.slug}.jsonl`);
        await writeJunitFromPerf(p.slug, entries);
        return entries;
      }),
    );
    const allPerf = perfByPhase.flat();
    const tests = allPerf.filter((e) => e.kind === 'test');
    const groups = allPerf.filter((e) => e.kind === 'suite' && e.nesting === 0);
    const totalTests = tests.length;
    const failedTests = tests.filter((t) => t.status === 'fail').length;
    const slowestTest = tests.reduce((m, e) => (e.ms > m.ms ? e : m), tests[0]);
    const slowestGroup = groups.reduce((m, e) => (e.ms > m.ms ? e : m), groups[0]);
    const fileMs = new Map<string, number>();
    for (const e of tests) if (e.file) fileMs.set(e.file, (fileMs.get(e.file) ?? 0) + e.ms);
    const [slowestFileName, slowestFileMs] = [...fileMs].reduce((m, e) => (e[1] > m[1] ? e : m), [
      '',
      0,
    ] as [string, number]);
    // Pipes in qunit module names ("Commands | Version tests") break markdown table cells;
    // escape with a backslash per GitHub-Flavored Markdown.
    const cell = (s: string): string => s.replace(/\|/g, '\\|');
    // slowestGroup intentionally omits a file path: node:test reports the suite event's
    // `file` as where qunit's `module()` is defined (its library), not where it's called.
    // Deriving the real file from child test events is unreliable under parallel test
    // workers (events interleave across files). Group qunit names are unique and greppable.
    summary =
      `## qunitx-cli test results\n\n` +
      `| metric | value |\n|---|---|\n` +
      `| tests | ${totalTests} ${failedTests ? `(${failedTests} failed)` : 'passed'} |\n` +
      `| files | ${fileMs.size} |\n` +
      `| duration | ${fmt(totalMs)} |\n` +
      (slowestFileName
        ? `| slowest file | \`${cell(slowestFileName)}\` (${fmt(slowestFileMs)} cumulative test time) |\n`
        : '') +
      (slowestGroup
        ? `| slowest group | ${cell(slowestGroup.name)} (${fmt(slowestGroup.ms)}) |\n`
        : '') +
      (slowestTest
        ? `| slowest test | ${cell(slowestTest.name)} — \`${cell(slowestTest.file)}\` (${fmt(slowestTest.ms)}) |\n`
        : '') +
      '\n';
  }
  process.stdout.write('\n' + summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

semaphore.close();
await runner.release();
process.exit(exitCode1 || exitCode2 || exitCode3);

async function runPhase(name: string, slug: string, files: string[]): Promise<number> {
  const start = performance.now();
  const exitCode = await spawnTests(files, slug);
  phaseResults.push({ name, slug, durationMs: performance.now() - start });
  return exitCode;
}

async function readPerf(perfPath: string): Promise<PerfEntry[]> {
  const text = await fs.readFile(perfPath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PerfEntry);
}

/**
 * Renders junit XML from a phase's perf JSONL — node:test's built-in junit reporter
 * omits per-testcase file paths and we'd be at 3 reporters anyway (warning-trippy),
 * so we generate it here from the data the ci-test-summary-reporter already captured.
 * Each test becomes a `<testcase>` with `classname=<file>` so dorny/test-reporter can
 * group failures by source file in PR check runs.
 */
async function writeJunitFromPerf(slug: string, entries: PerfEntry[]): Promise<void> {
  const tests = entries.filter((e) => e.kind === 'test');
  if (tests.length === 0) return;
  const xmlEsc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // One <testsuite> per source file so dorny renders failures grouped by file in
  // its check-run UI (instead of one big phase-named bucket). Each testsuite's
  // `name` is the file path; testcase `classname` keeps the same path so reporters
  // that group by classname (e.g. dorny's grouping in some configurations) also
  // work correctly.
  const byFile = new Map<string, PerfEntry[]>();
  for (const t of tests) {
    const file = t.file || `<${slug}>`;
    const existing = byFile.get(file);
    if (existing) existing.push(t);
    else byFile.set(file, [t]);
  }

  const renderCase = (t: PerfEntry, file: string): string => {
    const attrs = `name="${xmlEsc(t.name)}" classname="${xmlEsc(file)}" time="${(t.ms / 1000).toFixed(3)}"`;
    if (t.status === 'fail' && t.error) {
      const cdata = t.error.replace(/]]>/g, ']]]]><![CDATA[>');
      return `    <testcase ${attrs}><failure type="AssertionError"><![CDATA[${cdata}]]></failure></testcase>`;
    }
    return `    <testcase ${attrs}/>`;
  };

  const suites = [...byFile]
    .map(([file, fileTests]) => {
      const failed = fileTests.filter((t) => t.status === 'fail').length;
      const time = (fileTests.reduce((s, t) => s + t.ms, 0) / 1000).toFixed(3);
      const cases = fileTests.map((t) => renderCase(t, file)).join('\n');
      return (
        `  <testsuite name="${xmlEsc(file)}" tests="${fileTests.length}" failures="${failed}" time="${time}">\n` +
        `${cases}\n` +
        `  </testsuite>`
      );
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${suites}\n</testsuites>\n`;
  await fs.writeFile(`./tmp/junit-${RUN_ID}-${slug}.xml`, xml);
}

function spawnTests(files: string[], slug?: string): Promise<number> {
  return new Promise((resolve) => {
    const env = {
      // Default lives before ...process.env so a user override (incl.
      // `NODE_COMPILE_CACHE=` to disable) wins over our project default.
      // Harmless under Deno (it ignores the var).
      NODE_COMPILE_CACHE: COMPILE_CACHE_DIR,
      // Match the Chrome semaphore cap on Windows so deno test's worker pool
      // doesn't spawn 4 concurrent cli cold-starts (each a 190 MB embedded
      // VFS) only to have 2 of them queue forever on the semaphore — Windows
      // I/O contention from the queued workers themselves was contributing to
      // the same hang we're avoiding at the Chrome layer. DENO_JOBS is read
      // by `deno test --parallel` before workers fork, so it has to be in env
      // here (not on the args list). Set BEFORE ...process.env so user
      // overrides win.
      ...(process.platform === 'win32' && IS_DENO ? { DENO_JOBS: String(CHROME_CAP) } : {}),
      ...process.env,
      FORCE_COLOR: '0',
      QUNITX_SEMAPHORE_PORT: String(semaphore.port),
      // Block accidental daemon routing during the suite: a daemon running for this
      // project's cwd would be picked up by every `node cli.ts` invocation and
      // silently change behavior (TAP "(daemon)" suffix, single warm browser shared
      // across tests). The daemon test file deletes this var for its own client invocations.
      QUNITX_NO_DAEMON: '1',
    };

    if (IS_DENO) {
      // Deno path: `deno test --allow-all --no-check --parallel`.
      //   --allow-all  : same surface area as node (fs/net/child_process all needed).
      //   --no-check   : skip TS type-check at test time. Matches the Node lane (which
      //                  uses Node's strip-types — also no type-check) so the two runtimes
      //                  exercise the same code surface and one doesn't fail on .d.ts
      //                  inconsistencies in node_modules that aren't real bugs. Type
      //                  safety belongs in a dedicated `deno check lib/ test/ cli.ts`
      //                  step (single CI pass, fast feedback) — not per-phase test spawns
      //                  (3× the cost, repeated across the OS×browser matrix).
      //   --parallel   : run test MODULES in parallel (file granularity); semaphore still
      //                  caps Chrome instances at availableParallelism().
      //   --junit-path : deno writes junit XML directly (no perf-JSONL → junit step needed).
      //                  Caveat: deno's junit output emits a second <testsuite> per file
      //                  whose name points at qunitx's internal dist/deno/index.js (one
      //                  testcase per Deno.test.step). Dorny shows it; harmless but noisy.
      //   --preload    : DENO_TEST_TIMEOUT_PRELOAD wraps Deno.test with a per-test deadline.
      //                  Deno has no --test-timeout (still absent as of 2.9) and no timeout in
      //                  Deno.test's options, so a hung test used to consume the whole GHA job
      //                  — 25 min, cancelled, naming nothing. This gives the lane the same
      //                  fail-fast-by-name behaviour --test-timeout gives node. It does NOT
      //                  carry WORKER_PRELOAD's silent-death diagnostic: that translates a
      //                  node:test-specific symptom (whole file → one context-free 'test
      //                  failed') which deno's reporter doesn't have.
      // No --test-force-exit equivalent on deno; the outer GHA job-level timeout still backs
      // up anything the per-test deadline can't see (a hang at module top-level, or between
      // tests, rather than inside a test fn).
      const args = [
        'test',
        '--allow-all',
        '--no-check',
        '--parallel',
        `--preload=${DENO_TEST_TIMEOUT_PRELOAD}`,
        ...(slug ? [`--junit-path=./tmp/junit-${RUN_ID}-${slug}.xml`] : []),
        ...(watchMode ? ['--watch'] : []),
        ...files,
      ];
      const child = spawn(DENO_EXEC, args, { stdio: 'inherit', env });
      child.once('exit', (code) => resolve(code ?? 0));
      return;
    }

    // Node path. Two reporters are wired up in non-watch mode (3 trips node:test's
    // TestsStream default-10 listener limit; staying at 2 keeps stderr clean):
    //   spec   → stdout                        : compact, human/LLM-readable test output
    //                                            (no TAP YAML diagnostic blocks; ~80% less
    //                                             stdout noise on green runs).
    //   ci-test-summary → tmp/perf-<run>-<slug>.jsonl: per-test {name, file, ms, status, error?}
    //                                            JSONL — drives both the local end-of-run
    //                                            summary AND the junit XML written via
    //                                            writeJunitFromPerf() for dorny consumption.
    // Watch mode skips reporters: live spec output via stdio:inherit is what users want.
    const reporterArgs = slug
      ? [
          '--test-reporter=spec',
          '--test-reporter-destination=stdout',
          `--test-reporter=${REPORTER_PATH}`,
          `--test-reporter-destination=./tmp/perf-${RUN_ID}-${slug}.jsonl`,
        ]
      : [];
    const child = spawn(
      process.execPath,
      watchMode
        ? ['--import', WORKER_PRELOAD, '--test', '--watch', ...files]
        : [
            '--import',
            WORKER_PRELOAD,
            '--test',
            `--test-timeout=${PER_TEST_TIMEOUT_MS}`,
            ...reporterArgs,
            ...files,
          ],
      { stdio: 'inherit', env },
    );
    child.once('exit', (code) => resolve(code ?? 0));
  });
}

async function sweepOrphanedChrome(): Promise<void> {
  try {
    const tmpDir = os.tmpdir();
    const chromeDirs = (await fs.readdir(tmpDir)).filter((entry) =>
      entry.startsWith('qunitx-chrome-'),
    );
    if (chromeDirs.length === 0) return;

    if (process.platform === 'linux') {
      await Promise.all(
        (await fs.readdir('/proc')).map(async (entry) => {
          if (!/^\d+$/.test(entry)) return;
          try {
            const cmdline = await fs.readFile(`/proc/${entry}/cmdline`, 'utf8');
            if (!chromeDirs.some((dir) => cmdline.includes(dir))) return;
            const pid = parseInt(entry);
            // Only group-kill when this process is its own group leader (PGID === PID,
            // guaranteed when spawned with detached: true). Sending process.kill(-pid)
            // on a non-leader risks hitting an unrelated group if the PID was recycled.
            const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8').catch(() => '');
            const pgid = parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
            if (pgid === pid) {
              killProcessGroup(pid);
            } else {
              try {
                process.kill(pid, 'SIGKILL');
              } catch {
                /* already gone */
              }
            }
          } catch {
            /* /proc entry vanished mid-scan */
          }
        }),
      );
    } else if (process.platform === 'win32') {
      // Windows: no /proc, no pkill. Use PowerShell to find Chrome processes whose
      // CommandLine contains one of our user-data-dirs, then kill the whole process
      // tree with taskkill /T (same as killProcessGroup, but for already-orphaned
      // children whose parent Chrome has exited and left them behind).
      await Promise.all(
        chromeDirs.map(
          (dir) =>
            new Promise<void>((resolve) => {
              spawn(
                'powershell',
                [
                  '-NoProfile',
                  '-NonInteractive',
                  '-Command',
                  `Get-CimInstance Win32_Process | ` +
                    `Where-Object { $_.CommandLine -like '*${dir}*' } | ` +
                    `Select-Object -ExpandProperty ProcessId | ` +
                    `ForEach-Object { taskkill /F /T /PID $_ 2>$null }`,
                ],
                { stdio: 'ignore' },
              ).once('close', resolve);
            }),
        ),
      );
    } else {
      // macOS: no /proc. Use pkill -f to match by user-data-dir path in argv.
      await Promise.all(
        chromeDirs.map(
          (dir) =>
            new Promise<void>((resolve) => {
              spawn('pkill', ['-9', '-f', dir], { stdio: 'ignore' }).once('close', resolve);
            }),
        ),
      );
    }

    // cleanupBrowserDir kills any surviving FD-holders and retries rm() for up to 5s,
    // using rm() as the synchronisation point — correct even when zombie processes are
    // present (kill(pid, 0) succeeds for zombies but rm() does not).
    await Promise.all(chromeDirs.map((dir) => Chrome.cleanupDir(path.join(tmpDir, dir))));
  } catch {
    /* best effort — never block suite exit */
  }
}
