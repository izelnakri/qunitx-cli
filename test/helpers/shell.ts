import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { exec, spawn } from 'node:child_process';

const shell = promisify(exec);

// When QUNITX_BROWSER is set, all browser test runs use that engine (firefox, webkit, chromium).
const QUNITX_BROWSER = process.env.QUNITX_BROWSER;

// Spawns a long-running CLI command (e.g. --watch mode), collects stdout until
// `until(buf)` returns true, then kills the process.
export async function shellWatch(
  commandString: string,
  { until, timeout = 45000 }: { until?: (buf: string) => boolean; timeout?: number } = {},
): Promise<string> {
  let command = commandString;
  if (/\bnode cli\.ts\b/.test(command) && !/--output/.test(command)) {
    command = `${command} --output=tmp/run-${randomUUID()}`;
  }
  if (QUNITX_BROWSER && !/--browser/.test(command)) {
    command = `${command} --browser=${QUNITX_BROWSER}`;
  }

  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    ...command.split(/\s+/).slice(1),
  ]);

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
    const result = (await execute(commandString, options)) as ReturnType<typeof execute> & {
      code: number;
    };
    result.code = 0;
    return result;
  } catch (error) {
    return error;
  }
}

export default async function execute(
  commandString: string,
  { moduleName = '', testName = '' }: { moduleName?: string; testName?: string } = {},
) {
  // Each browser test run gets its own output dir so parallel runs never clobber each other.
  let command = commandString;
  if (/\bnode cli\.ts\b/.test(command) && !/--output/.test(command)) {
    command = `${command} --output=tmp/run-${randomUUID()}`;
  }

  const NON_BROWSER_SUBCOMMAND = /\bnode cli\.ts\b\s+(generate|g|new|n|help|h|p|print|init)\b/;
  const needsBrowser =
    /\bnode cli\.ts\b/.test(commandString) && !NON_BROWSER_SUBCOMMAND.test(commandString);

  if (needsBrowser && QUNITX_BROWSER && !/--browser/.test(command)) {
    command = `${command} --browser=${QUNITX_BROWSER}`;
  }

  // Ensure --experimental-strip-types is present for all Node invocations so .ts files load.
  command = command.replace(
    /\bnode\b(?!\s+--experimental-strip-types)/,
    'node --experimental-strip-types',
  );

  try {
    let result = await shell(command, { timeout: 60000 });
    let { stdout, stderr } = result;

    console.trace(`
      TEST NAME: ${moduleName} | ${testName}
      TEST COMMAND: ${command}
      ${stdout
        .split('\n')
        .map((line, index) => `${index}: ${line}`)
        .join('\n')}
    `);

    if (stderr && stderr !== '') {
      console.trace(`
        TEST NAME: ${moduleName} | ${testName}
        TEST COMMAND: ${command}
        ${stderr
          .split('\n')
          .map((line, index) => `${index}: ${line}`)
          .join('\n')}
      `);
    }

    return result;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    err.stdout ??= '';
    err.stderr ??= '';

    console.trace(`
      ERROR TEST Name: ${moduleName} | ${testName}
      ERROR TEST COMMAND: ${command}
      ${error}
    `);

    throw error;
  }
}
