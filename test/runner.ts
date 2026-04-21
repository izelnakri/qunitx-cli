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

const watchMode = process.argv.includes('--watch');
// --watch is never mixed with explicit file paths (see package.json scripts), so when
// it is present there are no explicit files; slice(2) is the file list otherwise.
const cliFiles = watchMode ? [] : process.argv.slice(2);

// Clearing artifacts, starting the semaphore server, and discovering test files are all
// independent — run them concurrently to cut startup time.
const [, semaphore, [fastFiles, watchReruns, leakFiles]] = await Promise.all([
  fs.rm('./tmp', { recursive: true, force: true }),
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

// Phase 1: fast suite — all tests except watch-rerun (concurrent)
const exitCode1 = await spawnTests(fastFiles);

// Sweep between phases: kill Chrome orphaned by SIGKILL'd watch-test.ts children before
// Phase 2 runs, so orphans from Phase 1 don't inflate the Phase 3 leak-test counts.
await sweepOrphanedChrome();

// Phase 2: watch-rerun suite — runs alone so its long-lived Chrome slots don't starve
// Phase 1 tests. Skipped in watch mode (watch-rerun tests are not meaningful there).
const exitCode2 = !watchMode && watchReruns.length > 0 ? await spawnTests(watchReruns) : 0;

// Sweep again: kill Chrome orphaned by the watch-rerun tests (SIGKILL'd on grace-period
// timeout) before the leak tests inspect /tmp and /proc.
await sweepOrphanedChrome();

// Phase 3: resource-leak tests, isolated after both sweeps so they see a clean state.
// Skipped in watch mode — interactive, and leak tests are not meaningful there.
const exitCode3 = !watchMode && leakFiles.length > 0 ? await spawnTests(leakFiles) : 0;

semaphore.close();
process.exit(exitCode1 || exitCode2 || exitCode3);

function spawnTests(files: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      watchMode ? ['--test', '--watch', ...files] : ['--test', '--test-force-exit', ...files],
      {
        stdio: 'inherit',
        env: { ...process.env, FORCE_COLOR: '0', QUNITX_SEMAPHORE_PORT: String(semaphore.port) },
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
              } catch {}
            }
          } catch {}
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
