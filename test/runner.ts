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

type PerfEntry = { name: string; file: string; ms: number; kind: string; nesting: number };

const REPORTER_PATH = path.resolve('test/helpers/ci-test-summary-reporter.ts');
const phaseResults: Array<{
  name: string;
  slug: string;
  tests: number;
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

// GitHub Actions step summary: small results table at the top of the run UI.
// No-op locally (GITHUB_STEP_SUMMARY unset) and in watch mode (no end-of-run).
if (!watchMode && process.env.GITHUB_STEP_SUMMARY) {
  let totalTests = 0;
  let totalMs = 0;
  let slowestPhase = phaseResults[0];
  for (const p of phaseResults) {
    totalTests += p.tests;
    totalMs += p.durationMs;
    if (p.durationMs > slowestPhase.durationMs) slowestPhase = p;
  }

  const allPerf = (
    await Promise.all(phaseResults.map((p) => readPerf(`./tmp/perf-${p.slug}.jsonl`)))
  ).flat();
  const tests = allPerf.filter((e) => e.kind === 'test');
  const groups = allPerf.filter((e) => e.kind === 'suite' && e.nesting === 0);
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
  // Pipes in qunit module names ("Commands | Version tests") break markdown
  // table cells; escape with a backslash per GitHub-Flavored Markdown.
  const cell = (s: string): string => s.replace(/\|/g, '\\|');
  // slowestGroup intentionally omits a file path: node:test reports the suite
  // event's `file` as where qunit's `module()` is *defined* (its library),
  // not where it's called. Deriving the real file from child test events is
  // unreliable under parallel test workers (events interleave across files).
  // The group's qunit name is unique and greppable on its own.
  await fs.appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## qunitx-cli test results\n\n` +
      `| metric | value |\n|---|---|\n` +
      `| tests | ${totalTests} ok |\n` +
      `| duration | ${fmt(totalMs)} |\n` +
      `| slowest phase | ${slowestPhase.name} (${fmt(slowestPhase.durationMs)}) |\n` +
      (slowestFileName
        ? `| slowest file | \`${cell(slowestFileName)}\` (${fmt(slowestFileMs)}) |\n`
        : '') +
      (slowestGroup
        ? `| slowest group | ${cell(slowestGroup.name)} (${fmt(slowestGroup.ms)}) |\n`
        : '') +
      (slowestTest
        ? `| slowest test | ${cell(slowestTest.name)} — \`${cell(slowestTest.file)}\` (${fmt(slowestTest.ms)}) |\n`
        : '') +
      '\n',
  );
}

semaphore.close();
process.exit(exitCode1 || exitCode2 || exitCode3);

async function runPhase(name: string, slug: string, files: string[]): Promise<number> {
  const start = performance.now();
  const { exitCode, tap } = await spawnTests(files, slug);
  phaseResults.push({
    name,
    slug,
    tests: Number(tap.match(/^# tests (\d+)$/m)?.[1] ?? 0),
    durationMs: performance.now() - start,
  });
  return exitCode;
}

async function readPerf(perfPath: string): Promise<PerfEntry[]> {
  const text = await fs.readFile(perfPath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PerfEntry);
}

function spawnTests(files: string[], slug?: string): Promise<{ exitCode: number; tap: string }> {
  return new Promise((resolve) => {
    // stdout is piped (not inherited) so we can scrape the trailing `# tests N`
    // summary while still streaming TAP to the parent stdout. When `slug` is
    // provided (non-watch mode), a second reporter writes per-test timing JSONL
    // to tmp/perf-<slug>.jsonl for the step-summary slowest-* rows.
    const reporterArgs = slug
      ? [
          '--test-reporter=tap',
          '--test-reporter-destination=stdout',
          `--test-reporter=${REPORTER_PATH}`,
          `--test-reporter-destination=./tmp/perf-${slug}.jsonl`,
        ]
      : [];
    const child = spawn(
      process.execPath,
      watchMode
        ? ['--test', '--watch', ...files]
        : ['--test', '--test-force-exit', ...reporterArgs, ...files],
      {
        stdio: watchMode ? 'inherit' : ['inherit', 'pipe', 'inherit'],
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
    let tap = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      tap += chunk.toString();
    });
    child.once('exit', (code) => resolve({ exitCode: code ?? 0, tap }));
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
