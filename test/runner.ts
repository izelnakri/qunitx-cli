/**
 * Unified test entrypoint: setup → semaphore server → run tests → exit.
 *
 * The Chrome semaphore server lives in this process (not detached), so it is automatically
 * cleaned up when the test run finishes. Its port is forwarded to all test worker threads
 * via the QUNITX_SEMAPHORE_PORT environment variable.
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

const watchMode = process.argv.includes('--watch');
// --watch is never mixed with explicit file paths (see package.json scripts), so when
// it is present there are no explicit files; slice(2) is the file list otherwise.
const cliFiles = watchMode ? [] : process.argv.slice(2);

// Clearing artifacts, starting the semaphore server, and discovering test files are all
// independent — run them concurrently to cut startup time.
const [, semaphore, [mainFiles, leakFiles]] = await Promise.all([
  fs.rm('./tmp', { recursive: true, force: true }),
  createSemaphoreServer(availableParallelism()),
  cliFiles.length > 0
    ? Promise.resolve([cliFiles, []] as [string[], string[]])
    : Promise.all([
        // *-test.ts  — main suite, runs concurrently.
        // *-leak.ts  — isolation tests; must run after the main suite + sweep because they
        //              check global state (/tmp dirs, /proc) and would see false orphans
        //              from concurrent watch-mode tests that legitimately SIGKILL node-cli.
        Array.fromAsync(fs.glob('test/**/*-test.ts')),
        Array.fromAsync(fs.glob('test/**/*-leak.ts')),
      ]),
]);

// Phase 1: main suite (concurrent)
const exitCode = await spawnTests(mainFiles);

// Kill Chrome processes orphaned when node-cli was SIGKILL'd by shellWatch's grace-period
// timeout. Chrome runs with detached: true so it survives without its exit handler running.
await sweepOrphanedChrome();

// Phase 2: resource-leak tests, isolated after the sweep so they see a clean state.
// Skipped in watch mode — interactive, and leak tests are not meaningful there.
const leakExitCode = !watchMode && leakFiles.length > 0 ? await spawnTests(leakFiles) : 0;

semaphore.close();
process.exit(exitCode || leakExitCode);

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
  if (process.platform === 'win32') return;
  try {
    const tmpDir = os.tmpdir();
    const chromeDirs = (await fs.readdir(tmpDir)).filter((e) => e.startsWith('qunitx-chrome-'));
    if (chromeDirs.length === 0) return;

    if (process.platform === 'linux') {
      const killedPids = new Set<number>();
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
            killedPids.add(pid);
          } catch {}
        }),
      );

      // Wait for killed processes to fully exit before removing their dirs.
      // A renderer still holding the dir as cwd causes rmdir to fail with EBUSY,
      // silently swallowed by .catch(() => {}). Poll /proc until confirmed gone.
      let remaining = [...killedPids];
      const deadline = Date.now() + 1000;
      while (remaining.length && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
        remaining = remaining.filter((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        });
      }
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

    // Remove dirs left behind when Chrome was killed before its async rm() ran.
    await Promise.all(
      chromeDirs.map((dir) =>
        fs.rm(path.join(tmpDir, dir), { recursive: true, force: true }).catch(() => {}),
      ),
    );
  } catch {
    /* best effort — never block suite exit */
  }
}
