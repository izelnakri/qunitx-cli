import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
// Use node:timers' setTimeout (returns a Timeout object with .unref()) rather than
// the global setTimeout. Under Deno, global setTimeout follows the web spec and
// returns a plain number — `.unref()` doesn't exist on a number, so the kill-timer
// teardown below would crash with `timer.unref is not a function`.
import { setTimeout, clearTimeout } from 'node:timers';
import { acquireBrowser } from './browser-semaphore-queue.ts';
import * as Result from '../../lib/result/index.ts';

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
// The two ways cli.ts returns before it ever reaches the run path, and so never
// touches a browser. Anything that skips Chrome must also skip acquireBrowser(),
// or it spends a CHROME_CAP slot idling and throttles the rest of the suite.
const NON_BROWSER_SUBCOMMAND =
  /\bnode cli\.ts\b\s+(generate|g|new|n|help|h|p|print|init|version|--version|-v)\b/;
// --search/--print/--preview/-s list what the filter matches and exit (cli.ts),
// and chrome/prelaunch.ts skips the spawn for the same argv scan.
const SEARCH_FLAG = /(^|\s)(-s|--search|--print|--preview)(=|\s|$)/;

// Default exec timeout for one-shot CLI invocations. Sized to comfortably exceed
// every observed tail of the Deno-compiled binary path under concurrent CI
// load (each cli call cold-loads ~190 MB of embedded VFS; daemon spawn time
// alone can reach SPAWN_TIMEOUT_MS = 120 s). 180 s leaves wraparound for the
// surrounding ping + assertion flow without letting a genuinely hung CLI
// stall the suite indefinitely. Cost is asymmetric — green runs finish in
// 2–10 s and aren't affected; a real hang takes 180 s to surface vs 90 s
// before. CI job budgets (15–25 min) absorb several such hangs.
const DEFAULT_EXEC_TIMEOUT_MS = 180_000;
// Default timeout for shellWatch — sized to the CLI's own startup safety net.
// lib/commands/run/tests-in-browser.ts STARTUP_TIMEOUT_FACTOR (9) × default
// config.timeout (20s) = 180s of CLI-internal WS-open wait, plus 30s for
// shellWatch's own Browser.setup + bundle + page.goto + ready-marker print.
// Bumped 120s → 180s → 210s over two iterations as STARTUP_TIMEOUT_FACTOR
// grew (webkit-on-macOS-deno hit 128s in CI 26045661239, JSX-on-macOS-deno
// hit 121s in CI 26046813154). Watch tests resolve in 1-5s on chromium, so
// the budget is only load-bearing for slow browsers under contention.
const DEFAULT_WATCH_TIMEOUT_MS = 210_000;
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

// Matches a single shell-style env assignment, e.g. `TZ=UTC` or `MY_VAR=foo/bar`.
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Parses a free-form command string into `{ bin, args, env }`. spawn() runs no shell, so it
 * does not interpret leading `VAR=value` assignments the way `TZ=UTC node …` requires —
 * exec() got that for free via cmd.exe / sh -c. This helper hand-rolls the only piece of
 * shell behaviour we actually rely on.
 *
 * The literal token `node` becomes `process.execPath` so callers can write `node cli.ts …`
 * cross-platform: process.execPath on Windows is `C:\\Program Files\\nodejs\\node.exe`,
 * a space-bearing path the naive whitespace split would fragment if it ever entered the
 * command string. Using the running binary also pins us to the same Node the test runner is
 * using — no PATH-drift surprises in the release-tarball matrix.
 *
 * Also handles the QUNITX_BIN swap so release-package tests can replace `node cli.ts` with
 * the installed entry point without re-parsing the rest of the command.
 */
/**
 * Splits a command into argv tokens, honouring single and double quotes so a flag value may
 * contain spaces (`-t 'outer first'`, `-m 'Outer > Inner'`) — commands here are spawned
 * without a shell, so nothing else would group those words.
 *
 * Quotes only group; there is no backslash escaping, which keeps Windows paths
 * (`D:\some\fixture.ts`) intact. An empty quoted string yields an empty token.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  let quoted = false;

  for (const char of command) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
    } else if (/\s/.test(char)) {
      if (current || quoted) {
        tokens.push(current);
        current = '';
        quoted = false;
      }
    } else {
      current += char;
    }
  }
  if (current || quoted) {
    tokens.push(current);
  }

  return tokens;
}

function parseCommand(command: string): {
  bin: string;
  args: string[];
  env: Record<string, string>;
} {
  const tokens = tokenize(command);
  // Boundary between leading env assignments and the bin+args tail. -1 from findIndex means
  // every token was an assignment — let `rest` be empty so the spawn surfaces ENOENT itself.
  const splitAt = tokens.findIndex((t) => !ENV_ASSIGNMENT_RE.test(t));
  const envEnd = splitAt === -1 ? tokens.length : splitAt;
  const env = Object.fromEntries(
    tokens.slice(0, envEnd).map((t) => {
      const eq = t.indexOf('=');
      return [t.slice(0, eq), t.slice(eq + 1)];
    }),
  );
  const rest = tokens.slice(envEnd);

  const cliIdx = rest.findIndex((t) => /\bcli\.ts$/.test(t));
  if (QUNITX_BIN && cliIdx >= 0) {
    const args = rest.slice(cliIdx + 1);
    return QUNITX_BIN_IS_SCRIPT
      ? { bin: process.execPath, args: [QUNITX_BIN, ...args], env }
      : { bin: QUNITX_BIN, args, env };
  }
  if (rest[0] === 'node') return { bin: process.execPath, args: rest.slice(1), env };
  return { bin: rest[0], args: rest.slice(1), env };
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
  {
    timeout = DEFAULT_EXEC_TIMEOUT_MS,
    env,
    cwd,
  }: { timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<CapturedResult> {
  const { bin, args, env: prefixEnv } = parseCommand(command);
  return await new Promise<CapturedResult>((resolve, reject) => {
    const startTime = performance.now();
    const child = spawn(bin, args, { env: { ...env, ...prefixEnv }, cwd });
    // EventEmitter throws unhandled 'error' events synchronously, and Node 24's default
    // for uncaughtException terminates the worker — which on Windows manifests as a
    // "test failed" at file:1:1 with no sub-test reported, because the worker died
    // before any test could finish. Child stdio pipes can emit 'error' (EPIPE / abrupt
    // close during TerminateProcess on Windows) independently of the child's own
    // 'error' event, so the listener on `child` alone isn't enough.
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
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
    // Resolve on 'close', not 'exit'. Per Node docs, 'exit' fires when the process has
    // terminated but child stdio streams may still be open — buffered 'data' events
    // arriving after 'exit' are then missed by the resolved promise. 'close' fires only
    // after every stdio stream has fully drained, so we capture the entire stdout/stderr.
    // This was reproducing as truncated CI captures on Windows: process exit at 7.68 s,
    // last captured stdout at 1.4 s, the intervening test+after-script output dropped.
    child.once('close', (code, signal) => {
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
    onSpawn,
    cwd,
  }: {
    until?: (buf: string) => boolean;
    timeout?: number;
    onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
    cwd?: string;
  } = {},
): Promise<string> {
  const command = applyImplicitFlags(commandString);
  const { bin, args, env: prefixEnv } = parseCommand(command);

  const permit = await acquireBrowser();
  const child = spawn(bin, args, {
    env: { ...process.env, FORCE_COLOR: '0', ...prefixEnv },
    ...(cwd ? { cwd } : {}),
  });
  // Attached BEFORE onSpawn (and before the data listener below) so any 'error'
  // surfaced through child stdio — most often during forced termination on Windows,
  // where SIGTERM = TerminateProcess abruptly closes the pipes — is absorbed instead
  // of bubbling to uncaughtException and killing the test worker. See spawnCapture
  // above for the matching note.
  child.stdin.on('error', () => {});
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});
  onSpawn?.(child);

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
      // No-op data listener drains stderr so it never blocks stdout.
      // resume() alone is unreliable under Deno's node:child_process compat —
      // the OS pipe doesn't get pumped, and a noisy stderr (e.g. cli
      // diagnostic warnings) back-pressures the writer and stalls the test.
      child.stderr.on('data', () => {});
      child.on('error', reject);
    });
  } finally {
    await terminateChild(child);
    permit.release();
  }
}

/**
 * Distinguishes "the child ran and exited non-zero" from "the child never started".
 *
 * `spawnCapture` rejects with two structurally different values: a `CapturedError` carrying
 * the full run diagnostics, and — via `child.once('error')` — a bare Node `Error` for a
 * spawn-level failure such as `ENOENT`. `duration` is present on the first and absent on the
 * second, because it is only ever set once the child has closed.
 */
function isProcessFailure(value: unknown): value is CapturedError {
  return value instanceof Error && typeof (value as CapturedError).duration === 'number';
}

/**
 * Runs a CLI command and returns its captured run **whatever exit code it produced**.
 *
 * For test files that drive the same command through both outcomes and assert the exit code
 * each time — `assert.exitCode(result, 0)` here, `assert.exitCode(result, 1)` there. Reaching
 * for `shellFails` in that situation is the mistake it looks like: the helper's name claims
 * a failure the caller does not actually require, so a run that unexpectedly succeeds is
 * indistinguishable from one that was supposed to.
 *
 * A spawn-level failure still propagates — a command that never started has no exit code to
 * assert on, and returning one would be an invention.
 */
export async function shellSettles(
  commandString: string,
  options: Parameters<typeof execute>[1] = {},
): Promise<CapturedResult> {
  const run = await Result.try(() => execute(commandString, { ...options, expectFailure: true }), {
    catch: isProcessFailure,
  });
  return run.ok ? run.value : run.error;
}

/**
 * Runs a CLI command that is *expected* to fail, and returns its captured run.
 *
 * The expected failure is declared, so the two things that are not expected stop being
 * silently absorbed:
 *
 *  - **The command succeeded.** Previously this returned the successful result with `code`
 *    overwritten to `0`, which only surfaced if the caller happened to follow up with
 *    `assert.exitCode(cmd, 1)`. It now fails immediately, at the call that was wrong, with
 *    the output that was not supposed to exist.
 *  - **The command never started.** A typo in the binary, or a missing `QUNITX_BIN`, rejects
 *    with a bare `Error` that has no `code`, `stdout` or `duration`. That used to be returned
 *    as a value and read back as `cmd.code === undefined`, so the test reported "expected 1,
 *    got undefined" instead of "spawn ENOENT". It is not matched here, so it propagates.
 *
 * The return type is now `CapturedResult` rather than the previous implicit
 * `CapturedResult | CapturedError | Error`, so the 40-odd call sites reading `.code`,
 * `.stdout` and `.stderr` are type-checked instead of duck-typed.
 */
export async function shellFails(
  commandString: string,
  options: Parameters<typeof execute>[1] = {},
): Promise<CapturedResult> {
  const run = await Result.try(
    () => execute(commandString, { ...options, expectFailure: true }),
    isProcessFailure,
  );
  if (run.ok) {
    throw new Error(
      `Expected \`${commandString}\` to fail, but it exited 0 after ${run.value.duration.toFixed(0)} ms.\n` +
        `STDOUT:\n${run.value.stdout.split('\n').slice(-30).join('\n')}`,
    );
  }
  return run.error;
}

export async function execute(
  commandString: string,
  {
    moduleName = '',
    testName = '',
    expectFailure = false,
    cwd,
  }: { moduleName?: string; testName?: string; expectFailure?: boolean; cwd?: string } = {},
): Promise<CapturedResult> {
  const command = applyImplicitFlags(commandString);
  const permit = needsBrowser(commandString) ? await acquireBrowser() : { release: () => {} };
  try {
    const result = await spawnCapture(command, {
      timeout: DEFAULT_EXEC_TIMEOUT_MS,
      env: { ...process.env, FORCE_COLOR: '0' },
      cwd,
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
  const browserRun = needsBrowser(commandString);
  let cmd =
    isCli && !/--output/.test(commandString)
      ? `${commandString} --output=tmp/run-${randomUUID()}`
      : commandString;
  if (browserRun && QUNITX_BROWSER && !/--browser/.test(cmd)) {
    cmd = `${cmd} --browser=${QUNITX_BROWSER}`;
  }
  if (browserRun && QUNITX_DEBUG && !/--debug/.test(cmd)) {
    cmd = `${cmd} --debug`;
  }
  return cmd;
}

/**
 * Whether this command will actually put a browser on screen — the sole input to
 * both the semaphore permit and the --browser/--debug forwarding above.
 */
export function needsBrowser(commandString: string): boolean {
  return (
    IS_CLI.test(commandString) &&
    !NON_BROWSER_SUBCOMMAND.test(commandString) &&
    !SEARCH_FLAG.test(commandString)
  );
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
/**
 * Sends SIGTERM, destroys stdio, and awaits the child's 'close' event (= process
 * exited AND stdio drained). If the child doesn't close within
 * CHILD_EXIT_GRACE_MS, escalates to SIGKILL and waits another POST_SIGKILL_DRAIN_MS.
 * If even that doesn't close it, throws — a genuinely undeadable child is a bug
 * worth surfacing loudly, not silently leaking.
 *
 * Exported so test files spawning their own long-running CLI children can reuse
 * the same escalation instead of reimplementing it inline. The prior in-test
 * reimplementations either missed the close-wait entirely (`no-html-test.ts`),
 * used 'exit' instead of 'close' (the stdio resource handle stays open past
 * 'exit', so Deno's leak sanitizer flagged tests as "child process not closed"
 * even after exit fired), or escaped the wait via a timer race that left
 * Deno's pending op_wait dangling.
 */
export async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform === 'win32') {
    // Windows: child.kill() is TerminateProcess(), which kills only the direct
    // child. The cli's Chrome subprocesses (renderer / GPU / crashpad helpers)
    // re-parent to wininit and orphan, eventually exhausting the GUI session
    // under load. `taskkill /F /T /PID` walks the process tree from the cli
    // PID and force-kills every descendant in one call — must be issued while
    // the parent is still alive so the tree walk can reach the children.
    await taskkillTree(child.pid);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    // Honor the timeout the way the POSIX branch below does. This used to discard
    // waitForClose's result and return as though the child had exited — so when the grace
    // expired, callers proceeded to fs.rm() against a live process tree and hit EBUSY/EPERM
    // on the directory its fs.watch handles were still holding. taskkill is re-issued because
    // a tree walk that raced a still-spawning descendant (Chrome/Firefox helper) can miss it.
    if (!(await waitForClose(child, CHILD_EXIT_GRACE_MS))) {
      await taskkillTree(child.pid);
      await waitForClose(child, CHILD_EXIT_GRACE_MS);
    }
    child.unref();
    return;
  }

  child.kill('SIGTERM');
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();

  if (await waitForClose(child, CHILD_EXIT_GRACE_MS)) {
    child.unref();
    return;
  }

  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  if (await waitForClose(child, POST_SIGKILL_DRAIN_MS)) {
    child.unref();
    return;
  }

  child.unref();
  throw new Error(
    `Child process (pid=${child.pid}) failed to close within ${CHILD_EXIT_GRACE_MS}ms after SIGTERM + ${POST_SIGKILL_DRAIN_MS}ms after SIGKILL. exitCode=${child.exitCode} signalCode=${child.signalCode}`,
  );
}

/**
 * Force-kills a Windows process tree from `pid` down, resolving once taskkill itself has
 * exited. Spawned rather than spawnSync'd: terminateChild runs in the finally of every
 * shellWatch, and a synchronous tree walk freezes the whole worker — the timers and sockets
 * of every other test sharing it included. Nothing here needed the sync form; the ordering
 * requirement is that taskkill has finished before we go on to wait for the child, and
 * awaiting gives exactly that. 'error' resolves too, so a missing taskkill degrades to the
 * SIGTERM path instead of rejecting out of a cleanup block.
 */
function taskkillTree(pid: number | undefined): Promise<void> {
  return new Promise((resolve) => {
    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
      .once('close', () => resolve())
      .once('error', () => resolve());
  });
}

// 'close' (not 'exit') is the lifecycle event that releases the OS-level stdio
// handles Deno tracks for leak detection. Awaiting 'exit' returned before stdio
// streams had drained, leaving Deno's child-process resource still flagged.
function waitForClose(child: ChildProcessWithoutNullStreams, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref();
    child.once('close', () => {
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
  if (err.stdout) {
    // Tail rather than full dump: failing-CLI stdouts are often hundreds of TAP
    // lines, but the diagnostic value lives at the end (last assertion, summary
    // line, crash trace). Reading raw CI logs without this tail forces digging
    // into chunk buffers in IDE — which the per-chunk timestamps above point at.
    const allLines = err.stdout.split('\n');
    const tail = allLines.slice(-50).join('\n');
    const truncated = allLines.length > 50 ? ` (last 50 of ${allLines.length} lines)` : '';
    lines.push(`STDOUT${truncated}:\n${tail}`);
  }
  if (err.stderr) lines.push(`STDERR: ${err.stderr}`);
  return lines.join('\n');
}
