import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { exec, spawn } from 'node:child_process';
import { acquireBrowser } from './browser-semaphore-queue.ts';

const shell = promisify(exec);

// When QUNITX_BROWSER is set, all browser test runs use that engine (firefox, webkit, chromium).
const QUNITX_BROWSER = process.env.QUNITX_BROWSER;
// When QUNITX_BIN is set, `node cli.ts` is replaced with the installed binary.
// Used by scripts/test-release.sh to verify the published package end-to-end.
const QUNITX_BIN = process.env.QUNITX_BIN;
// When QUNITX_DEBUG is set, --debug is appended to all browser CLI invocations.
// Used by `npm run test:debug` / `make test-debug` to surface debug TAP comments.
const QUNITX_DEBUG = process.env.QUNITX_DEBUG;

const IS_CLI = /\bnode cli\.ts\b/;
const NON_BROWSER_SUBCOMMAND = /\bnode cli\.ts\b\s+(generate|g|new|n|help|h|p|print|init)\b/;

// Maximum time to wait for a child process to exit after SIGTERM before giving up.
// Prevents a stuck child (e.g. Firefox/WebKit SIGTERM deadlock) from indefinitely
// blocking the semaphore permit and starving subsequent test workers.
const CHILD_EXIT_GRACE_MS = 5000;

// Spawns a long-running CLI command (e.g. --watch mode), collects stdout until
// `until(buf)` returns true, then kills the process.
export async function shellWatch(
  commandString: string,
  { until, timeout = 45000 }: { until?: (buf: string) => boolean; timeout?: number } = {},
): Promise<string> {
  const withOutput =
    IS_CLI.test(commandString) && !/--output/.test(commandString)
      ? `${commandString} --output=tmp/run-${randomUUID()}`
      : commandString;

  const withBrowser =
    QUNITX_BROWSER && !/--browser/.test(withOutput)
      ? `${withOutput} --browser=${QUNITX_BROWSER}`
      : withOutput;

  const command =
    QUNITX_DEBUG && IS_CLI.test(commandString) && !/--debug/.test(withBrowser)
      ? `${withBrowser} --debug`
      : withBrowser;

  const [bin, spawnArgs] =
    QUNITX_BIN && IS_CLI.test(commandString)
      ? [
          QUNITX_BIN,
          command
            .replace(/\bnode\s+cli\.ts\b/, '')
            .trim()
            .split(/\s+/)
            .filter(Boolean),
        ]
      : [process.execPath, command.split(/\s+/).slice(1)];

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
    child.kill('SIGTERM');
    // Destroy all three stdio pipes. spawn() opens stdin/stdout/stderr as ref'd libuv
    // handles. If Playwright's SIGTERM handler hangs while closing Firefox/WebKit, the
    // child never exits and all three pipes stay open, keeping the worker event loop alive.
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    // Wait for the child to fully exit before releasing the permit. This prevents the next
    // test from acquiring the permit (and launching a new Chrome) while the previous
    // Chrome and its HTTP server are still shutting down.
    //
    // Race against CHILD_EXIT_GRACE_MS: if the child hangs (e.g. Firefox/WebKit SIGTERM
    // deadlock), force-kill it so it doesn't linger as an orphan holding Chrome processes
    // and inotify watches. Any Chrome subprocesses that survive the SIGKILL (because
    // process.on('exit') doesn't fire on SIGKILL) are swept up by runner.ts on suite exit.
    const childExited = await new Promise<boolean>((resolve) => {
      const exitTimer = setTimeout(() => resolve(false), CHILD_EXIT_GRACE_MS);
      exitTimer.unref();
      child.once('exit', () => {
        clearTimeout(exitTimer);
        resolve(true);
      });
    });
    // Force-kill if SIGTERM didn't work within the grace period. Any Chrome subprocesses
    // orphaned because SIGKILL bypasses the process.on('exit') handler are swept up by
    // runner.ts after the full suite exits.
    if (!childExited) {
      try {
        child.kill('SIGKILL');
      } catch {}
      // SIGKILL delivery and process termination are asynchronous at the OS level.
      // The child may still hold its HTTP server port for a brief moment after kill()
      // returns. Wait for the 'exit' event before releasing the permit so the next
      // test worker does not try to bind the same port while the child is still dying.
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const t = setTimeout(resolve, 2000);
        (t as NodeJS.Timeout).unref();
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    child.unref();
    permit.release();
  }
}

export async function shellFails(commandString: string, options = {}) {
  try {
    const result = (await execute(commandString, {
      ...options,
      expectFailure: true,
    })) as ReturnType<typeof execute> & { code: number };
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
) {
  // Each browser test run gets its own output dir so parallel runs never clobber each other.
  const withOutput =
    IS_CLI.test(commandString) && !/--output/.test(commandString)
      ? `${commandString} --output=tmp/run-${randomUUID()}`
      : commandString;

  const needsBrowser = IS_CLI.test(commandString) && !NON_BROWSER_SUBCOMMAND.test(commandString);

  const withBrowser =
    needsBrowser && QUNITX_BROWSER && !/--browser/.test(withOutput)
      ? `${withOutput} --browser=${QUNITX_BROWSER}`
      : withOutput;

  const withDebug =
    needsBrowser && QUNITX_DEBUG && !/--debug/.test(withBrowser)
      ? `${withBrowser} --debug`
      : withBrowser;

  const command =
    QUNITX_BIN && IS_CLI.test(commandString)
      ? withDebug.replace(/\bnode\s+cli\.ts\b/, QUNITX_BIN)
      : withDebug;

  const permit = needsBrowser ? await acquireBrowser() : { release: () => {} };
  try {
    const result = await shell(command, {
      timeout: 60000,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    if (process.env.QUNITX_VERBOSE) {
      console.error(`COMMAND: ${command}\n${result.stdout}`);
      if (result.stderr) console.error(`STDERR: ${result.stderr}`);
    }

    return result;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    err.stdout ??= '';
    err.stderr ??= '';

    if (!expectFailure) {
      console.error(`TEST FAILED: ${moduleName} | ${testName}\nCOMMAND: ${command}\n${error}`);
    }

    throw error;
  } finally {
    permit.release();
  }
}
