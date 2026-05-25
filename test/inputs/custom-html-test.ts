import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { exec as execCb, spawn } from 'node:child_process';
// node:timers' setTimeout returns a Timeout object with .unref() in both Node and
// Deno; the global setTimeout under Deno returns a plain number (web spec) and
// crashes on .unref().
import { setTimeout, clearTimeout } from 'node:timers';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import '../helpers/custom-asserts.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import { terminateChild } from '../helpers/shell.ts';

const exec = promisify(execCb);
const CLI = path.resolve('cli.ts');

module('Input | custom html', { concurrency: true }, () => {
  test('runs tests inside a passed custom.html that uses handlebars-style syntax', async (assert) => {
    const { dir, id } = await makeCustomHTMLProject();
    const outputDir = path.resolve(`tmp/run-${randomUUID()}`);

    try {
      const permit = await acquireBrowser();
      const { stdout } = await exec(
        `node ${CLI} tests/passing-tests.ts custom.html --output=${outputDir}`,
        { cwd: dir, timeout: 60000 },
      ).finally(() => permit.release());

      assert.includes(stdout, 'QUnitX running: http://localhost:');
      assert.includes(stdout, '/custom.html');
      assert.passingTestCaseFor({ stdout }, { moduleName: id });
      assert.tapResult({ stdout }, { testCount: 3 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('watch mode uses a passed custom.html that uses handlebars-style syntax', async (assert) => {
    const { dir, id } = await makeCustomHTMLProject();

    try {
      const stdout = await runWatch(dir);

      assert.includes(stdout, 'QUnitX running: http://localhost:');
      assert.includes(stdout, '/custom.html');
      assert.passingTestCaseFor(stdout, { moduleName: id });
      assert.tapResult(stdout, { testCount: 3 });
      assert.includes(stdout, 'Watching files...');
    } finally {
      await rmRetry(dir);
    }
  });
});

// On Windows, fs.watch holds directory handles briefly after process exit — retry on EBUSY.
async function rmRetry(dir: string, attemptsLeft = 5, delayMs = 300): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || attemptsLeft <= 1) throw error;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    await rmRetry(dir, attemptsLeft - 1, delayMs + 300);
  }
}

async function makeCustomHTMLProject() {
  const id = randomUUID();
  const dir = path.resolve(`tmp/custom-html-${id}`);
  const testsDir = `${dir}/tests`;
  await fs.mkdir(testsDir, { recursive: true });

  const [template] = await Promise.all([
    fs.readFile(path.resolve('test/helpers/passing-tests.ts'), 'utf8'),
    fs.writeFile(
      `${dir}/package.json`,
      JSON.stringify({ name: id, version: '0.0.1', type: 'module' }, null, 2),
    ),
    fs.symlink(path.resolve('node_modules'), `${dir}/node_modules`),
  ]);

  await Promise.all([
    fs.writeFile(`${testsDir}/passing-tests.ts`, template.replace('{{moduleName}}', id)),
    fs.writeFile(
      `${dir}/custom.html`,
      `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${id}</title>
    <link href="./node_modules/qunitx/vendor/qunit.css" rel="stylesheet">
  </head>
  <body>
    <section data-template="{{pageShell}}"></section>
  </body>
</html>`,
    ),
  ]);

  return { dir, id };
}

// Mirrors STARTUP_TIMEOUT_FACTOR * config.timeout in lib/commands/run/tests-in-browser.ts
// (9 * 20s = 180s) plus a 30s buffer for setupBrowser + bundle + page.goto + the
// `Press "qq"` ready-marker print. Bumped 45s → 150s → 210s as STARTUP_TIMEOUT_FACTOR
// grew over two iterations (firefox-on-macOS-deno hit 45s in CI 26042614416;
// JSX-on-macOS-deno hit 121s in CI 26046813154).
const WATCH_READY_TIMEOUT_MS = 210_000;

async function runWatch(dir: string): Promise<string> {
  const outputDir = path.resolve(`tmp/run-${randomUUID()}`);
  const permit = await acquireBrowser();
  const child = spawn(
    process.execPath,
    [CLI, 'tests/passing-tests.ts', 'custom.html', '--watch', `--output=${outputDir}`],
    { cwd: dir },
  );

  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`watch mode timed out after ${WATCH_READY_TIMEOUT_MS}ms`)),
        WATCH_READY_TIMEOUT_MS,
      );
      let buf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        if (buf.includes('Press "qq"')) {
          clearTimeout(timer);
          resolve(buf);
        }
      });
      // Drain stderr so a noisy cli (diagnostic warnings) can't fill the OS
      // pipe and stall. Plain .resume() is unreliable under Deno compat.
      child.stderr.on('data', () => {});
      child.on('error', reject);
    });
  } finally {
    // terminateChild awaits 'close' (not 'exit'), so on Windows fs.watch directory
    // handles inside the child are released before the test's fs.rm() runs —
    // otherwise rmdir fails with EBUSY.
    await terminateChild(child);
    permit.release();
  }
}
