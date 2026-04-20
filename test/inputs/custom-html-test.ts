import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { exec as execCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import '../helpers/custom-asserts.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';

const exec = promisify(execCb);
const CLI = path.resolve('cli.ts');

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
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

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
        () => reject(new Error('watch mode timed out after 45000ms')),
        45000,
      );
      let buf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        if (buf.includes('Press "qq"')) {
          clearTimeout(timer);
          resolve(buf);
        }
      });
      child.stderr.resume();
      child.on('error', reject);
    });
  } finally {
    child.kill('SIGTERM');
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    // Wait for the child to fully exit before releasing the permit. On Windows,
    // fs.watch holds directory handles; if the process hasn't exited when the
    // test's finally-block runs fs.rm(), rmdir fails with EBUSY.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5000);
      (t as NodeJS.Timeout).unref();
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    child.unref();
    permit.release();
  }
}
