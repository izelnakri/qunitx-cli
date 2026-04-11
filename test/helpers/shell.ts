import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { exec, spawn } from 'node:child_process';

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
    // Unref the child process itself. Even after destroying all stdio pipes, the
    // ChildProcess handle is ref'd until the OS process exits. If Playwright's SIGTERM
    // handler hangs (e.g. Firefox/WebKit graceful-close deadlock), the child never exits
    // and the worker thread's event loop stays alive indefinitely. unref() lets the worker
    // exit without waiting for the child OS process to terminate.
    child.unref();
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
  }
}
