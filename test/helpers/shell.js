import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { exec, spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

const shell = promisify(exec);

// In-process async semaphore. node --test runs each test file in its own worker thread,
// but --test-concurrency=1 ensures only one file runs at a time, so this semaphore is
// effectively global across the entire test run. No TCP server needed.
//
// Cap at availableParallelism() so CI (2-core) runs 2 concurrent browsers at most.
// The "TAP version 13\n / exit 0" flakiness that previously forced slots=1 is fixed in
// pre-launch-chrome.js: the earlyBrowserPromise now resolves null unconditionally when
// Chrome exits before printing its CDP URL (OOM kill, clean exit, signal), so
// launchBrowser always falls back to chromium.launch() instead of hanging forever.
let slots = availableParallelism();
const waiters = [];

function acquireSlot() {
  if (slots > 0) {
    slots--;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot() {
  if (waiters.length > 0) {
    waiters.shift()();
  } else {
    slots++;
  }
}

// When QUNITX_BROWSER is set, all browser test runs use that engine (firefox, webkit, chromium).
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
  await acquireSlot();
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
    releaseSlot();
  }
}

export async function shellFails(commandString, options = {}) {
  try {
    const result = await execute(commandString, options);
    result.code = 0;
    return result;
  } catch (error) {
    return error;
  }
}

export default async function execute(commandString, { moduleName = '', testName = '' } = {}) {
  // Each browser test run gets its own output dir so parallel runs never clobber each other.
  let command = commandString;
  if (/\bnode cli\.js\b/.test(command) && !/--output/.test(command)) {
    command = `${command} --output=tmp/run-${randomUUID()}`;
  }

  const NON_BROWSER_SUBCOMMAND = /\bnode cli\.js\b\s+(generate|g|new|n|help|h|p|print|init)\b/;
  const needsBrowser =
    /\bnode cli\.js\b/.test(commandString) && !NON_BROWSER_SUBCOMMAND.test(commandString);

  if (needsBrowser && QUNITX_BROWSER && !/--browser/.test(command)) {
    command = `${command} --browser=${QUNITX_BROWSER}`;
  }

  if (needsBrowser) await acquireSlot();

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
    error.stdout ??= '';
    error.stderr ??= '';

    console.trace(`
      ERROR TEST Name: ${moduleName} | ${testName}
      ERROR TEST COMMAND: ${command}
      ${error}
    `);

    throw error;
  } finally {
    if (needsBrowser) releaseSlot();
  }
}
