import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { exec, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';

const shell = promisify(exec);

// Cross-process semaphore: connect to the server started by test/setup.js.
// All test workers share a single global Chrome slot count via TCP.
let semaphorePort = null;
async function getPort() {
  if (!semaphorePort) {
    semaphorePort = parseInt(await readFile('tmp/.semaphore-port', 'utf8'), 10); // NOTE: Should this in FS or in memory?
  }
  return semaphorePort;
}

// NOTE: What is the point of starting sockets and writing to them? Seems like quite a bit junk code here
async function acquireSlot() {
  const port = await getPort();
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(port, '127.0.0.1');
    let buf = '';
    sock.on('connect', () => sock.write('acquire\n'));
    sock.on('data', (data) => {
      buf += data.toString();
      if (buf.includes('ok')) resolve(sock);
    });
    sock.on('error', reject);
  });
}

function releaseSlot(sock) {
  return new Promise((resolve) => {
    sock.once('data', () => {
      sock.destroy();
      resolve();
    });
    sock.once('error', resolve);
    sock.write('release\n');
  });
}

// When QUNITX_BROWSER is set, all browser test runs use that engine (firefox, webkit, chromium).
// This lets the same test files run against any Playwright-supported browser without modification:
//   QUNITX_BROWSER=firefox npm test   or   make test-firefox
const QUNITX_BROWSER = process.env.QUNITX_BROWSER;

// Spawns a long-running CLI command (e.g. --watch mode), collects stdout until
// `until(buf)` returns true, then kills the process and releases the semaphore.
export async function shellWatch(commandString, { until, timeout = 45000 } = {}) {
  let command = commandString;
  if (/\bnode cli\.js\b/.test(command) && !/--output/.test(command)) {
    command = `${command} --output=tmp/run-${randomUUID()}`;
  }
  if (QUNITX_BROWSER && !/--browser/.test(command)) {
    command = `${command} --browser=${QUNITX_BROWSER}`;
  }

  const [, ...args] = command.split(/\s+/); // strip 'node', keep the rest
  const sock = await acquireSlot();
  const child = spawn(process.execPath, args);

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
    await releaseSlot(sock);
  }
}

export async function shellFails(commandString, options = {}) {
  try {
    await execute(commandString, options);
    return null;
  } catch (error) {
    return error;
  }
}

export default async function execute(
  commandString,
  { moduleName = '', testName = '', noSemaphore = false } = {},
) {
  // Each browser test run gets its own output dir so parallel runs never clobber each other.
  // Only applied when the command targets cli.js and doesn't already specify --output.
  let command = commandString;
  if (/\bnode cli\.js\b/.test(command) && !/--output/.test(command)) {
    command = `${command} --output=tmp/run-${randomUUID()}`;
  }

  // The semaphore guards browser concurrency. Subcommands that never launch a browser
  // (generate / help / init) skip it so they don't occupy a slot that browser tests need.
  const NON_BROWSER_SUBCOMMAND = /\bnode cli\.js\b\s+(generate|g|new|n|help|h|p|print|init)\b/;
  const needsBrowser =
    /\bnode cli\.js\b/.test(commandString) && !NON_BROWSER_SUBCOMMAND.test(commandString);

  // Inject --browser flag when QUNITX_BROWSER is set and the command doesn't already specify one.
  if (needsBrowser && QUNITX_BROWSER && !/--browser/.test(command)) {
    command = `${command} --browser=${QUNITX_BROWSER}`;
  }

  let sock = null;

  try {
    sock = needsBrowser && !noSemaphore ? await acquireSlot() : null;
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
    error.stdout ??= '';
    error.stderr ??= '';

    console.trace(`
      ERROR TEST Name: ${moduleName} | ${testName}
      ERROR TEST COMMAND: ${command}
      ${error}
    `);

    throw error;
  } finally {
    if (sock) await releaseSlot(sock);
  }
}
