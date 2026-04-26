import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { acquireBrowser } from './browser-semaphore-queue.ts';

// When QUNITX_BROWSER is set, all browser test runs use that engine (firefox, webkit, chromium).
const QUNITX_BROWSER = process.env.QUNITX_BROWSER;
// When QUNITX_BIN is set, `node cli.ts` is replaced with the installed binary.
// Used by scripts/test-release.sh to verify the published package end-to-end.
// On Windows, shell wrapper scripts in node_modules/.bin/ cannot be spawned directly
// (spawn requires an actual executable). test-release.sh sets QUNITX_BIN to the .js
// entry point on Windows; we detect this by the .js extension and invoke via node.
const QUNITX_BIN = process.env.QUNITX_BIN;
const QUNITX_BIN_IS_SCRIPT = QUNITX_BIN?.endsWith('.js') || QUNITX_BIN?.endsWith('.ts');
// When QUNITX_DEBUG is set, --debug is appended to all browser CLI invocations.
// Used by `npm run test:debug` / `make test-debug` to surface debug TAP comments.
const QUNITX_DEBUG = process.env.QUNITX_DEBUG;

const IS_CLI = /\bnode cli\.ts\b/;
const NON_BROWSER_SUBCOMMAND = /\bnode cli\.ts\b\s+(generate|g|new|n|help|h|p|print|init)\b/;

// Default exec timeout for one-shot CLI invocations. Long enough to absorb cold Chrome
// startup on Windows CI, short enough that a genuinely hung CLI doesn't stall the suite.
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
// Default timeout for shellWatch — slightly shorter; watch tests usually wait for a specific
// stdout marker rather than full process exit.
const DEFAULT_WATCH_TIMEOUT_MS = 45_000;
// Maximum time to wait for a child process to exit after SIGTERM before giving up.
// Prevents a stuck child (e.g. Firefox/WebKit SIGTERM deadlock) from indefinitely
// blocking the semaphore permit and starving subsequent test workers.
const CHILD_EXIT_GRACE_MS = 5_000;
// Bound after SIGKILL where we still wait for the OS exit event so the child's HTTP server
// port is fully released before the next test acquires the semaphore.
const POST_SIGKILL_DRAIN_MS = 2_000;

/**
 * Rich result returned by every CLI invocation. The `code`, `signal`, and `duration` fields
 * (plus the per-chunk stdout/stderr timeline) are exactly the diagnostics that turn an
 * inscrutable "exit 0 with truncated stdout" Windows flake into a self-explaining failure —
 * we can see whether the child hung for seconds before exiting or exited at the first chunk,
 * and whether stderr emitted anything we missed.
 */
export interface CapturedResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Wall-clock ms from spawn() to the child's 'exit' event. */
  duration: number;
  /** Per-chunk stdout arrival times (ms since spawn). Always captured for failure diagnostics. */
  stdoutChunks: ReadonlyArray<{ time: number; data: string }>;
  stderrChunks: ReadonlyArray<{ time: number; data: string }>;
}

/** Error thrown by spawnCapture when the child exits non-zero or via a signal. */
export type CapturedError = Error & CapturedResult & { expectFailure?: boolean };

/**
 * Splits a free-form command string into a `[bin, args[]]` pair suitable for `spawn()`.
 *
 * The literal token `node` is replaced with `process.execPath` so callers can write
 * `node cli.ts ...` cross-platform — `process.execPath` on Windows is
 * `C:\\Program Files\\nodejs\\node.exe` (a path with spaces) which the naive whitespace
 * split would otherwise fragment, and using the running binary instead of PATH-resolved
 * `node` also avoids version-drift surprises in release-tarball matrix jobs.
 *
 * Also handles the QUNITX_BIN replacement so release-package tests can swap `node cli.ts`
 * for the installed binary without re-parsing the rest of the command.
 */
function parseCommand(command: string): [string, string[]] {
  const tokens = command.split(/\s+/).filter(Boolean);
  const cliIdx = tokens.findIndex((t) => /\bcli\.ts$/.test(t));
  if (QUNITX_BIN && cliIdx >= 0) {
    const args = tokens.slice(cliIdx + 1);
    return QUNITX_BIN_IS_SCRIPT ? [process.execPath, [QUNITX_BIN, ...args]] : [QUNITX_BIN, args];
  }
  if (tokens[0] === 'node') return [process.execPath, tokens.slice(1)];
  return [tokens[0], tokens.slice(1)];
}

/**
 * Spawns a child process and captures everything we might want to inspect when a test fails:
 * full stdout/stderr, exit code, terminating signal, total runtime, and per-chunk arrival
 * timestamps. Resolves on `code === 0 && signal === null`; rejects with an Error that carries
 * the same fields so callers (and `shellFails`) can introspect failures uniformly.
 *
 * Replaces `promisify(child_process.exec)` because exec swallows the terminating signal on
 * Windows, hides timing data, and wraps everything in cmd.exe — none of which help when
 * diagnosing a "child exited cleanly with truncated stdout" flake.
 */
export async function spawnCapture(
  command: string,
  { timeout = DEFAULT_EXEC_TIMEOUT_MS, env }: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CapturedResult> {
  const [bin, args] = parseCommand(command);
  return await new Promise<CapturedResult>((resolve, reject) => {
    const startTime = performance.now();
    const child = spawn(bin, args, { env });
    const stdoutChunks: Array<{ time: number; data: string }> = [];
    const stderrChunks: Array<{ time: number; data: string }> = [];
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      stdoutChunks.push({ time: performance.now() - startTime, data });
      stdout += data;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      stderrChunks.push({ time: performance.now() - startTime, data });
      stderr += data;
    });

    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    timer.unref();

    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      const result: CapturedResult = {
        stdout,
        stderr,
        code,
        signal,
        duration: performance.now() - startTime,
        stdoutChunks,
        stderrChunks,
      };
      if (code === 0 && signal === null) {
        resolve(result);
      } else {
        reject(makeCapturedError(result));
      }
    });
  });
}

/**
 * Spawns a long-running CLI command (e.g. --watch mode), collects stdout until
 * `until(buf)` returns true, then kills the process.
 */
export async function shellWatch(
  commandString: string,
  {
    until,
    timeout = DEFAULT_WATCH_TIMEOUT_MS,
  }: { until?: (buf: string) => boolean; timeout?: number } = {},
): Promise<string> {
  const command = applyImplicitFlags(commandString);
  const [bin, spawnArgs] = parseCommand(command);

  const permit = await acquireBrowser();
  const child = spawn(bin, spawnArgs, { env: { ...process.env, FORCE_COLOR: '0' } });

  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`shellWatch timed out after ${timeout}ms`)),
        timeout,
      );
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        if (!until || until(buf)) {
          clearTimeout(timer);
          resolve(buf);
        }
      });
      child.stderr.resume(); // drain stderr so it never blocks stdout
      child.on('error', reject);
    });
  } finally {
    await terminateChild(child);
    permit.release();
  }
}

export async function shellFails(commandString: string, options = {}) {
  try {
    const result = (await execute(commandString, {
      ...options,
      expectFailure: true,
    })) as CapturedResult & { code: number };
    // The command succeeded when shellFails expected failure. Force `code` to 0 so a
    // following `assert.exitCode(cmd, <non-zero>)` flags the unexpected success cleanly.
    result.code = 0;
    return result;
  } catch (error) {
    return error;
  }
}

export default async function execute(
  commandString: string,
  {
    moduleName = '',
    testName = '',
    expectFailure = false,
  }: { moduleName?: string; testName?: string; expectFailure?: boolean } = {},
): Promise<CapturedResult> {
  const command = applyImplicitFlags(commandString);
  const needsBrowser = IS_CLI.test(commandString) && !NON_BROWSER_SUBCOMMAND.test(commandString);
  const permit = needsBrowser ? await acquireBrowser() : { release: () => {} };
  try {
    const result = await spawnCapture(command, {
      timeout: DEFAULT_EXEC_TIMEOUT_MS,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    if (process.env.QUNITX_VERBOSE) {
      console.error(`COMMAND: ${command}\n${result.stdout}`);
      if (result.stderr) console.error(`STDERR: ${result.stderr}`);
    }

    return result;
  } catch (error) {
    if (!expectFailure) {
      console.error(formatTestFailure(moduleName, testName, command, error as CapturedError));
    } else {
      // Tag the error so callers (shellFails) can distinguish expected from unexpected.
      (error as CapturedError).expectFailure = true;
    }
    throw error;
  } finally {
    permit.release();
  }
}

/**
 * Applies the --output, --browser, and --debug flags that every CLI test invocation needs:
 *   --output: a unique tmp/run-<uuid> dir so parallel runs never clobber each other
 *   --browser: forwarded from QUNITX_BROWSER env (browser-compat matrix in CI)
 *   --debug: forwarded from QUNITX_DEBUG env (npm run test:debug / make test-debug)
 */
function applyImplicitFlags(commandString: string): string {
  const isCli = IS_CLI.test(commandString);
  const needsBrowser = isCli && !NON_BROWSER_SUBCOMMAND.test(commandString);
  let cmd =
    isCli && !/--output/.test(commandString)
      ? `${commandString} --output=tmp/run-${randomUUID()}`
      : commandString;
  if (needsBrowser && QUNITX_BROWSER && !/--browser/.test(cmd)) {
    cmd = `${cmd} --browser=${QUNITX_BROWSER}`;
  }
  if (needsBrowser && QUNITX_DEBUG && !/--debug/.test(cmd)) {
    cmd = `${cmd} --debug`;
  }
  return cmd;
}

/**
 * Sends SIGTERM, waits up to CHILD_EXIT_GRACE_MS for graceful exit, escalates to SIGKILL,
 * then waits up to POST_SIGKILL_DRAIN_MS for the OS exit event so the child's HTTP server
 * port is fully released before the next test acquires the semaphore.
 *
 * Destroys all three stdio handles up-front: spawn() opens them as ref'd libuv handles, and
 * if the child hangs in its SIGTERM handler (Playwright Firefox/WebKit do this regularly),
 * those handles keep the worker event loop alive forever.
 */
async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.kill('SIGTERM');
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();

  const exited = await waitForExit(child, CHILD_EXIT_GRACE_MS);
  if (!exited) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    if (child.exitCode === null && child.signalCode === null) {
      await waitForExit(child, POST_SIGKILL_DRAIN_MS);
    }
  }
  child.unref();
}

function waitForExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Wraps a CapturedResult into an Error so it can be thrown while keeping all diagnostics. */
function makeCapturedError(result: CapturedResult): CapturedError {
  const summary = result.signal
    ? `Process killed by ${result.signal} after ${result.duration.toFixed(0)} ms`
    : `Process exited with code ${result.code} after ${result.duration.toFixed(0)} ms`;
  return Object.assign(new Error(summary), result) as CapturedError;
}

/**
 * Builds the diagnostic block printed by `execute()` when an unexpected child failure
 * occurs. Surfaces the exit code, signal, duration, stderr, and the timestamp of the last
 * stdout chunk — collectively enough to tell at a glance whether the child crashed early,
 * hung silently, or wrote nothing after some point.
 */
function formatTestFailure(
  moduleName: string,
  testName: string,
  command: string,
  err: CapturedError,
): string {
  const lastStdout = err.stdoutChunks?.at(-1);
  const lastStderr = err.stderrChunks?.at(-1);
  const lines = [
    `TEST FAILED: ${moduleName} | ${testName}`,
    `COMMAND: ${command}`,
    `exit: code=${err.code} signal=${err.signal} duration=${err.duration?.toFixed(0)}ms`,
    `last stdout chunk: ${lastStdout ? `${lastStdout.time.toFixed(0)}ms (${lastStdout.data.length} bytes)` : '<none>'}`,
    `last stderr chunk: ${lastStderr ? `${lastStderr.time.toFixed(0)}ms (${lastStderr.data.length} bytes)` : '<none>'}`,
  ];
  if (err.stderr) lines.push(`STDERR: ${err.stderr}`);
  return lines.join('\n');
}
