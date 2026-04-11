import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';

const execAsync = promisify(exec);

// Absolute path to cli.ts so we can invoke it from a different working directory.
const CLI = `${process.cwd()}/cli.ts`;

// Creates a minimal project in tmp/<id>/ with its own package.json and a passing
// test file — no test/tests.html. node_modules is symlinked from the repo root so
// that esbuild can resolve qunitx and the runner can copy its vendor assets.
//
// withHtmlPaths: true  → simulates "qunitx init was run then tests.html deleted":
//                        package.json has qunitx.htmlPaths pointing to a missing file.
// withHtmlPaths: false → simulates a fresh project where qunitx init was never run:
//                        package.json has no qunitx config at all.
async function makeMinimalProject({ withHtmlPaths }: { withHtmlPaths: boolean }) {
  const id = randomUUID();
  const dir = `${process.cwd()}/tmp/${id}`;
  await fs.mkdir(`${dir}/tests`, { recursive: true });

  const pkg = withHtmlPaths
    ? { name: id, version: '0.0.1', type: 'module', qunitx: { htmlPaths: ['test/tests.html'] } }
    : { name: id, version: '0.0.1', type: 'module' };

  await fs.writeFile(`${dir}/package.json`, JSON.stringify(pkg, null, 2));

  // Symlink node_modules so qunitx (imported by the test file) and qunit.css
  // (copied to the output dir by the runner) are available without a full npm install.
  await fs.symlink(`${process.cwd()}/node_modules`, `${dir}/node_modules`);

  // Replace {{moduleName}} so the TAP module name is deterministic and unique per run.
  const template = await fs.readFile(`${process.cwd()}/test/helpers/passing-tests.ts`);
  await fs.writeFile(
    `${dir}/tests/passing-tests.ts`,
    template.toString().replace('{{moduleName}}', id),
  );

  return { dir, id };
}

async function runWatch(dir: string, id: string) {
  const outputDir = `${process.cwd()}/tmp/run-${randomUUID()}`;
  const child = spawn(
    process.execPath,
    [CLI, 'tests/passing-tests.ts', '--watch', `--output=${outputDir}`],
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
    child.unref();
  }
}

module('No-HTML project tests', (_hooks, moduleMetadata) => {
  // Scenario A: qunitx init was never run — no htmlPaths in package.json, no tests.html.
  test('runs in normal mode when qunitx init was never run (no htmlPaths configured)', async (assert) => {
    const { dir, id } = await makeMinimalProject({ withHtmlPaths: false });
    const outputDir = `${process.cwd()}/tmp/run-${randomUUID()}`;

    const result = await execAsync(`node ${CLI} tests/passing-tests.ts --output=${outputDir}`, {
      cwd: dir,
      timeout: 60000,
    });

    assert.includes(result, 'TAP version 13');
    assert.passingTestCaseFor(result, { moduleName: id });
    assert.tapResult(result, { testCount: 3 });
  });

  test('runs in --watch mode when qunitx init was never run (no htmlPaths configured)', async (assert) => {
    const { dir, id } = await makeMinimalProject({ withHtmlPaths: false });
    const stdout = await runWatch(dir, id);

    assert.includes({ stdout }, 'TAP version 13');
    assert.passingTestCaseFor({ stdout }, { moduleName: id });
    assert.tapResult({ stdout }, { testCount: 3 });
    assert.includes({ stdout }, 'Watching files...');
    assert.includes({ stdout }, 'http://localhost:');
    assert.includes({ stdout }, 'Press "qq"');
  });

  // Scenario B: qunitx init was run (htmlPaths configured) but tests.html was deleted.
  test('runs in normal mode when htmlPaths is configured but test/tests.html was deleted', async (assert) => {
    const { dir, id } = await makeMinimalProject({ withHtmlPaths: true });
    const outputDir = `${process.cwd()}/tmp/run-${randomUUID()}`;

    const result = await execAsync(`node ${CLI} tests/passing-tests.ts --output=${outputDir}`, {
      cwd: dir,
      timeout: 60000,
    });

    assert.includes(result, 'TAP version 13');
    assert.passingTestCaseFor(result, { moduleName: id });
    assert.tapResult(result, { testCount: 3 });
  });

  test('runs in --watch mode when htmlPaths is configured but test/tests.html was deleted', async (assert) => {
    const { dir, id } = await makeMinimalProject({ withHtmlPaths: true });
    const stdout = await runWatch(dir, id);

    assert.includes({ stdout }, 'TAP version 13');
    assert.passingTestCaseFor({ stdout }, { moduleName: id });
    assert.tapResult({ stdout }, { testCount: 3 });
    assert.includes({ stdout }, 'Watching files...');
    assert.includes({ stdout }, 'http://localhost:');
    assert.includes({ stdout }, 'Press "qq"');
  });
});
