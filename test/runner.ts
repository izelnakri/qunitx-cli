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
import createSemaphoreServer from './helpers/semaphore-server.ts';
import { killProcessGroup } from '../lib/utils/kill-process-group.ts';
import { cleanupBrowserDir } from '../lib/utils/cleanup-browser-dir.ts';

// Project-local V8 compile-cache dir for spawned workers and the cli.ts
// processes the test files invoke. Sits under node_modules/.cache (npm
// convention, gitignored, survives `rm -rf tmp/`, outside the leak-test sweep
// which only scans qunitx-chrome-* under os.tmpdir()). The runner itself
// doesn't enable compile cache — its module graph is small and doing so would
// pollute process.env, overriding the project-local default below.
const COMPILE_CACHE_DIR = path.resolve('node_modules/.cache/qunitx/v8');

// Per-test deadline passed to `node --test --test-timeout=N`. node:test fails any
// test whose runtime exceeds this and force-completes its subtests, so a hung
// test surfaces by name in the spec output and the worker moves on cleanly —
// no zombies, no SIGKILL hammer, no whole-phase loss.
//
// Sized to comfortably exceed the slowest observed healthy test. Watch-rerun
// tests are the long tail: per-test wall clock has been observed up to 120 s
// on slow CI runners under contention (Windows + concurrent Chrome launches).
// Daemon tests' rapid-stop+start used to peak at 120 s pre-leak-fix; current
// healthy max is ~15 s. 300 s = 5 min ≈ 2.5× the observed slow tail leaves
// room for the runner's natural tail variance without misfiring on real-but-
// slow runs. Anything past 5 min is genuinely stuck.
//
// Below this the per-call `DEFAULT_EXEC_TIMEOUT_MS = 180_000` in
// test/helpers/shell.ts cuts off individual cli invocations; this is the
// outer safety net for the test itself.
//
// Above this, GitHub Actions' job-level `timeout-minutes` (15 on ubuntu, 25
// on macos/windows in ci.yml) is the ultimate fallback if --test-timeout
// somehow fails to release a worker (rare: requires a worker stuck in a
// non-interruptible syscall). We don't add a phase-level SIGKILL deadman of
// our own because it'd leave orphan cli/daemon/Chrome processes the next run
// would inherit, and `--test-timeout` already covers the case that actually
// matters.
const PER_TEST_TIMEOUT_MS = 300_000;

const watchMode = process.argv.includes('--watch');
// --watch is never mixed with explicit file paths (see package.json scripts), so when
// it is present there are no explicit files; slice(2) is the file list otherwise.
const cliFiles = watchMode ? [] : process.argv.slice(2);

// Clearing artifacts, starting the semaphore server, and discovering test files are all
// independent — run them concurrently to cut startup time. tmp/ is recreated after the
// rm so node:test can open the per-phase perf-reporter destination on phase 1 spawn.
const [, semaphore, [fastFiles, watchReruns, leakFiles]] = await Promise.all([
  fs
    .rm('./tmp', { recursive: true, force: true })
    .then(() => fs.mkdir('./tmp', { recursive: true })),
  createSemaphoreServer(availableParallelism()),
  cliFiles.length > 0
    ? Promise.resolve([cliFiles, [], []] as [string[], string[], string[]])
    : Promise.all([
        // *-test.ts (excluding watch-rerun) — fast suite, runs concurrently.
        // watch-rerun-test.ts  — slow suite; runs alone in Phase 2 so its 17 long-lived
        //                        Chrome slots don't starve Phase 1 tests.
        // *-leak.ts  — isolation tests; must run after the main suite + sweep because they
        //              check global state (/tmp dirs, /proc) and would see false orphans
        //              from concurrent watch-mode tests that legitimately SIGKILL node-cli.
        Array.fromAsync(fs.glob('test/**/*-test.ts')).then((files) =>
          files.filter((f) => !f.includes('watch-rerun')),
        ),
        Array.fromAsync(fs.glob('test/**/watch-rerun-test.ts')),
        Array.fromAsync(fs.glob('test/**/*-leak.ts')),
      ]),
]);

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
// data: URL preloaded into each `node --test` worker via --import. Widens util.inspect's
// defaults so node:test's spec-reporter failure formatter shows the full assertion `actual`
// (captured stdout, error chunks) instead of `[Object]` / truncated `'...'`. Inline as a
// data URL — `--import` accepts ESM data URLs natively, so we get the preload without a
// separate helper file. (`--test-reporter` does NOT accept data URLs; it parses the value
// as a file path and rejects schemes like `d:` — that's why the ci-test-summary-reporter
// is a real file but this preload isn't.)
const WORKER_PRELOAD = `data:text/javascript;base64,${Buffer.from(
  'import{inspect}from"node:util";' +
    'const o=inspect.defaultOptions;' +
    'o.breakLength=240;o.depth=Infinity;o.maxStringLength=Infinity;o.maxArrayLength=Infinity;',
).toString('base64')}`;
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
// appends the same markdown to $GITHUB_STEP_SUMMARY when set, and writes one junit
// XML per phase for dorny/test-reporter consumption.
if (!watchMode) {
  let totalMs = 0;
  for (const p of phaseResults) totalMs += p.durationMs;

  // Read perf JSONL per phase, generate junit XML alongside (consumed by
  // .github/workflows/test-report.yml → dorny). Reading and writing in parallel.
  const perfByPhase = await Promise.all(
    phaseResults.map(async (p) => {
      const entries = await readPerf(`./tmp/perf-${p.slug}.jsonl`);
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

  const fmt = (ms: number): string =>
    ms >= 60_000
      ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
      : `${(ms / 1000).toFixed(1)}s`;
  // Pipes in qunit module names ("Commands | Version tests") break markdown table cells;
  // escape with a backslash per GitHub-Flavored Markdown.
  const cell = (s: string): string => s.replace(/\|/g, '\\|');
  // slowestGroup intentionally omits a file path: node:test reports the suite event's
  // `file` as where qunit's `module()` is defined (its library), not where it's called.
  // Deriving the real file from child test events is unreliable under parallel test
  // workers (events interleave across files). Group qunit names are unique and greppable.
  const summary =
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
  process.stdout.write('\n' + summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

semaphore.close();
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
  await fs.writeFile(`./tmp/junit-${slug}.xml`, xml);
}

function spawnTests(files: string[], slug?: string): Promise<number> {
  return new Promise((resolve) => {
    // Two reporters are wired up in non-watch mode (3 trips node:test's TestsStream
    // default-10 listener limit; staying at 2 keeps stderr clean):
    //   spec   → stdout                        : compact, human/LLM-readable test output
    //                                            (no TAP YAML diagnostic blocks; ~80% less
    //                                             stdout noise on green runs).
    //   ci-test-summary → tmp/perf-<slug>.jsonl: per-test {name, file, ms, status, error?}
    //                                            JSONL — drives both the local end-of-run
    //                                            summary AND the junit XML written via
    //                                            writeJunitFromPerf() for dorny consumption.
    // Watch mode skips reporters: live spec output via stdio:inherit is what users want.
    const reporterArgs = slug
      ? [
          '--test-reporter=spec',
          '--test-reporter-destination=stdout',
          `--test-reporter=${REPORTER_PATH}`,
          `--test-reporter-destination=./tmp/perf-${slug}.jsonl`,
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
            '--test-force-exit',
            `--test-timeout=${PER_TEST_TIMEOUT_MS}`,
            ...reporterArgs,
            ...files,
          ],
      {
        stdio: 'inherit',
        env: {
          // Default lives before ...process.env so a user override (incl.
          // `NODE_COMPILE_CACHE=` to disable) wins over our project default.
          NODE_COMPILE_CACHE: COMPILE_CACHE_DIR,
          ...process.env,
          FORCE_COLOR: '0',
          QUNITX_SEMAPHORE_PORT: String(semaphore.port),
          // Block accidental daemon routing during the suite: a daemon running for this
          // project's cwd would be picked up by every `node cli.ts` invocation and
          // silently change behavior (TAP "(daemon)" suffix, single warm browser shared
          // across tests). The daemon test file deletes this var for its own client invocations.
          QUNITX_NO_DAEMON: '1',
        },
      },
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
    await Promise.all(chromeDirs.map((dir) => cleanupBrowserDir(path.join(tmpDir, dir))));
  } catch {
    /* best effort — never block suite exit */
  }
}
