import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';

const execAsync = promisify(exec);

// Absolute path to cli.ts so we can invoke it from a different working directory.
const CLI = `${process.cwd()}/cli.ts`;

module('No-HTML project tests', { concurrency: true }, (_hooks, _moduleMetadata) => {
  // Both normal-mode scenarios (no htmlPaths config vs missing htmlPaths file) are
  // independent — run them concurrently within a single test so both Chrome instances
  // acquire their semaphore slots simultaneously (wall time = max(a,b), not a+b).
  test('runs in normal mode regardless of whether htmlPaths is configured', async (assert) => {
    const [projectA, projectB] = await Promise.all([
      makeMinimalProject({ withHtmlPaths: false }),
      makeMinimalProject({ withHtmlPaths: true }),
    ]);

    const [permitA, permitB] = await Promise.all([acquireBrowser(), acquireBrowser()]);
    const [resultA, resultB] = await Promise.all([
      execAsync(
        `node ${CLI} tests/passing-tests.ts --output=${process.cwd()}/tmp/run-${randomUUID()}`,
        {
          cwd: projectA.dir,
          timeout: 60000,
        },
      ).finally(() => permitA.release()),
      execAsync(
        `node ${CLI} tests/passing-tests.ts --output=${process.cwd()}/tmp/run-${randomUUID()}`,
        {
          cwd: projectB.dir,
          timeout: 60000,
        },
      ).finally(() => permitB.release()),
    ]);

    // Scenario A: no htmlPaths configured (qunitx init never run)
    assert.includes(resultA, 'TAP version 13');
    assert.passingTestCaseFor(resultA, { moduleName: projectA.id });
    assert.tapResult(resultA, { testCount: 3 });

    // Scenario B: htmlPaths configured but test/tests.html was deleted
    assert.includes(resultB, 'TAP version 13');
    assert.passingTestCaseFor(resultB, { moduleName: projectB.id });
    assert.tapResult(resultB, { testCount: 3 });
  });

  // Same pairing for watch mode.
  test('runs in --watch mode regardless of whether htmlPaths is configured', async (assert) => {
    const [projectA, projectB] = await Promise.all([
      makeMinimalProject({ withHtmlPaths: false }),
      makeMinimalProject({ withHtmlPaths: true }),
    ]);

    const [stdoutA, stdoutB] = await Promise.all([
      runWatch(projectA.dir, projectA.id),
      runWatch(projectB.dir, projectB.id),
    ]);

    // Scenario A: no htmlPaths configured
    assert.includes({ stdout: stdoutA }, 'TAP version 13');
    assert.passingTestCaseFor({ stdout: stdoutA }, { moduleName: projectA.id });
    assert.tapResult({ stdout: stdoutA }, { testCount: 3 });
    assert.includes({ stdout: stdoutA }, 'Watching files...');
    assert.includes({ stdout: stdoutA }, 'http://localhost:');
    assert.includes({ stdout: stdoutA }, 'Press "qq"');

    // Scenario B: htmlPaths configured but tests.html deleted
    assert.includes({ stdout: stdoutB }, 'TAP version 13');
    assert.passingTestCaseFor({ stdout: stdoutB }, { moduleName: projectB.id });
    assert.tapResult({ stdout: stdoutB }, { testCount: 3 });
    assert.includes({ stdout: stdoutB }, 'Watching files...');
    assert.includes({ stdout: stdoutB }, 'http://localhost:');
    assert.includes({ stdout: stdoutB }, 'Press "qq"');
  });
});

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

async function runWatch(dir: string, _id: string) {
  const outputDir = `${process.cwd()}/tmp/run-${randomUUID()}`;
  const permit = await acquireBrowser();
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
    permit.release();
  }
}
