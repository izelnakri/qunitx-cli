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
import { availableParallelism } from 'node:os';
import { spawn } from 'node:child_process';
import createSemaphoreServer from './helpers/semaphore-server.ts';

// ─── Setup ───────────────────────────────────────────────────────────────────
// Clear previous run artifacts. Individual tests create their own tmp/ subdirs
// with { recursive: true }, so no pre-creation is needed.
await fs.rm('./tmp', { recursive: true, force: true });

// ─── Semaphore server ─────────────────────────────────────────────────────────

const semaphore = await createSemaphoreServer(availableParallelism());
const semaphorePort = semaphore.port;

// ─── Run tests ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const watchMode = argv.includes('--watch');
const explicitFiles = argv.filter((a) => a !== '--watch');
const testFiles =
  explicitFiles.length > 0
    ? explicitFiles
    : (await Array.fromAsync(fs.glob('test/**/*-test.ts'))).sort();

const child = spawn(
  process.execPath,
  watchMode ? ['--test', '--watch', ...testFiles] : ['--test', '--test-force-exit', ...testFiles],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      QUNITX_SEMAPHORE_PORT: String(semaphorePort),
    },
  },
);

const exitCode = await new Promise<number>((resolve) =>
  child.on('exit', (code) => resolve(code ?? 0)),
);

semaphore.close();
process.exit(exitCode);
