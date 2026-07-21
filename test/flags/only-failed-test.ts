import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import { shellFails, shellWatch } from '../helpers/shell.ts';

const CWD = process.cwd();

interface OnlyFailedProject {
  cwd: string;
}

module('Flags | --only-failed', { concurrency: true }, () => {
  test('caches only the failing file and re-runs just that file', async (assert) => {
    const project = await makeProject();

    // Full run: one file fails. The cache should hold only the failing file, not the passing one.
    const first = await runCli(project, 'test/');
    assert.exitCode(first, 1);
    assert.includes(first, '# fail 1');

    const cache = await readCache(project);
    assert.ok(cache, 'failure cache written after the run');
    assert.equal(cache?.files.length, 1, 'exactly one file cached');
    // Normalize separators: the cached path is absolute and OS-native (backslashes on Windows).
    assert.ok(
      cache?.files[0].replace(/\\/g, '/').endsWith('test/fail-test.js'),
      'the failing file is the one cached',
    );

    // --only-failed with no targets re-runs exactly the cached file (1 test, still failing).
    const second = await runCli(project, '--only-failed');
    assert.exitCode(second, 1);
    assert.includes(second, 're-running 1 previously-failing test file');
    assert.includes(second, '# tests 1');
    assert.includes(second, 'Fail | is broken');
    assert.notIncludes(second, 'Pass | stays green');
  });

  test('a passing re-run empties the cache; the next --only-failed runs nothing', async (assert) => {
    const project = await makeProject();

    const first = await runCli(project, 'test/');
    assert.exitCode(first, 1);

    // Fix the failing test, then re-run only the failure. It now passes and the cache empties.
    await fs.writeFile(
      path.join(project.cwd, 'test/fail-test.js'),
      passingTest('Fail', 'is broken'),
    );
    const fixed = await runCli(project, '--only-failed');
    assert.exitCode(fixed, 0);
    assert.includes(fixed, '# pass 1');
    assert.equal((await readCache(project))?.files.length, 0, 'cache emptied after a green re-run');

    // With an empty cache there is nothing to re-run: clean 0-test exit, no fallback to all.
    const empty = await runCli(project, '--only-failed');
    assert.exitCode(empty, 0);
    assert.includes(empty, 'no previously-failing test files to run');
    assert.includes(empty, '1..0');
    assert.notIncludes(empty, '# pass 1');
  });

  test('a missing cache falls back to running all tests', async (assert) => {
    const project = await makeProject();

    // No prior run, so no cache file exists yet.
    const result = await runCli(project, 'test/ --only-failed');
    assert.exitCode(result, 1);
    assert.includes(result, 'no failure cache found — running all tests');
    assert.includes(result, '# tests 2');
  });

  test('scopes the cached failures to the given input targets', async (assert) => {
    const project = await makeProject();

    const first = await runCli(project, 'test/');
    assert.exitCode(first, 1);

    // Targeting only the passing file: the intersection with the cached failures is empty,
    // so nothing runs even though a failure is cached elsewhere.
    const scoped = await runCli(project, 'test/pass-test.js --only-failed');
    assert.exitCode(scoped, 0);
    assert.includes(scoped, 'no previously-failing test files to run');
    assert.includes(scoped, '1..0');
  });

  test('--watch scopes only the initial run to the cached failures', async (assert) => {
    const project = await makeProject();

    // Seed the cache with a full run (fail-test fails, pass-test passes).
    const first = await runCli(project, 'test/');
    assert.exitCode(first, 1);

    // watch + --only-failed: the first run is scoped to just the failing file (the full set stays
    // watched, with qa/qf as escape hatches). shellWatch acquires its own browser permit and
    // returns stdout up to the watching banner, then terminates the watcher.
    const stdout = await shellWatch(`node ${CWD}/cli.ts test/ --only-failed --watch`, {
      cwd: project.cwd,
      until: (buf) => buf.includes('Press "qq"'),
    });
    assert.includes(stdout, 'first run scoped to 1 previously-failing test file');
    assert.includes(stdout, '# tests 1');
    assert.includes(stdout, 'Fail | is broken');
    assert.notIncludes(stdout, 'Pass | stays green');
  });
});

// A self-contained project with one always-passing and one failing test file, symlinking
// node_modules to the parent so qunitx + esbuild resolve. Same pattern as changed-test.ts.
// Each project gets a unique cwd, so its tmp/.qunitx-last-failures.json is isolated from
// other parallel tests while surviving across sequential runs within one test.
async function makeProject(): Promise<OnlyFailedProject> {
  const id = crypto.randomUUID();
  const cwd = path.join(CWD, 'tmp', `only-failed-${id}`);
  await Promise.all([
    writeWithMkdir(path.join(cwd, 'test/pass-test.js'), passingTest('Pass', 'stays green')),
    writeWithMkdir(path.join(cwd, 'test/fail-test.js'), failingTest('Fail', 'is broken')),
  ]);
  await Promise.all([
    fs.symlink(path.join(CWD, 'node_modules'), path.join(cwd, 'node_modules')),
    writeWithMkdir(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: id, version: '0.0.1', type: 'module' }),
    ),
    writeWithMkdir(path.join(cwd, '.gitignore'), 'node_modules/\ntmp/\n'),
  ]);
  return { cwd };
}

function passingTest(moduleName: string, testName: string): string {
  return (
    [
      `import { module, test } from 'qunitx';`,
      `module('${moduleName}', () => { test('${testName}', (assert) => assert.ok(true)); });`,
    ].join('\n') + '\n'
  );
}

function failingTest(moduleName: string, testName: string): string {
  return (
    [
      `import { module, test } from 'qunitx';`,
      `module('${moduleName}', () => { test('${testName}', (assert) => assert.ok(false, 'boom')); });`,
    ].join('\n') + '\n'
  );
}

async function writeWithMkdir(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

// cwd puts the run inside the project so qunitx resolves its package.json + tests, not
// qunitx-cli's. The failure cache lives at the project's literal
// tmp/.qunitx-last-failures.json — independent of --output. shellFails rather than shell
// because failing runs are the point here, and it returns the CapturedError with the same
// { code, stdout } shape the asserts read.
function runCli(project: OnlyFailedProject, args: string) {
  return shellFails(`node ${CWD}/cli.ts ${args}`, { cwd: project.cwd });
}

async function readCache(project: OnlyFailedProject): Promise<{ files: string[] } | null> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(project.cwd, 'tmp/.qunitx-last-failures.json'), 'utf8'),
    );
  } catch {
    return null;
  }
}
