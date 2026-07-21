import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import { spawnCapture, shellWatch } from '../helpers/shell.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import * as MetafileCache from '../../lib/utils/metafile-cache.ts';

const execFileAsync = promisify(execFile);
const CWD = process.cwd();

interface ChangedProject {
  cwd: string;
}

// Build a self-contained git project with src + tests, symlinking node_modules
// to the parent so qunitx + esbuild resolve. Same pattern as daemon-test.ts.
async function makeChangedProject(): Promise<ChangedProject> {
  const id = crypto.randomUUID();
  const cwd = path.join(CWD, 'tmp', `changed-${id}`);
  await fs.mkdir(cwd, { recursive: true });
  // All file/dir creation under cwd is independent — fan out in one Promise.all.
  // `writeWithMkdir` ensures the target's parent exists per-write so we don't
  // need to pre-create `src/` and `test/` separately.
  await Promise.all([
    fs.symlink(path.join(CWD, 'node_modules'), path.join(cwd, 'node_modules')),
    writeWithMkdir(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: id, version: '0.0.1', type: 'module' }),
    ),
    writeWithMkdir(path.join(cwd, '.gitignore'), 'node_modules/\ntmp/\n'),
    writeWithMkdir(path.join(cwd, 'src/a.ts'), 'export const a = 1;\n'),
    writeWithMkdir(path.join(cwd, 'src/b.ts'), 'export const b = 2;\n'),
    writeWithMkdir(
      path.join(cwd, 'test/a-test.ts'),
      [
        `import { module, test } from 'qunitx';`,
        `import { a } from '../src/a.ts';`,
        `module('a', () => { test('a===1', (assert) => assert.equal(a, 1)); });`,
      ].join('\n') + '\n',
    ),
    writeWithMkdir(
      path.join(cwd, 'test/b-test.ts'),
      [
        `import { module, test } from 'qunitx';`,
        `import { b } from '../src/b.ts';`,
        `module('b', () => { test('b===2', (assert) => assert.equal(b, 2)); });`,
      ].join('\n') + '\n',
    ),
  ]);

  // Inline `-c` user info on commit — avoids touching `.git/config` and the
  // lock-file race two parallel `git config` calls would hit.
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd });
  await execFileAsync('git', ['add', '-A'], { cwd });
  await execFileAsync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'init'],
    { cwd },
  );

  return { cwd };
}

async function writeWithMkdir(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

// Default `shell` doesn't forward cwd, and these tests must run inside their
// per-project directory so qunitx finds their package.json + test files (not
// qunitx-cli's). spawnCapture takes cwd directly. Auto-output keeps parallel
// runs from clobbering one another.
async function runCli(project: ChangedProject, args: string) {
  const id = crypto.randomUUID();
  const permit = await acquireBrowser();
  try {
    return await spawnCapture(`node ${CWD}/cli.ts ${args} --output=tmp/run-${id}`, {
      env: { ...process.env, FORCE_COLOR: '0' },
      cwd: project.cwd,
    });
  } finally {
    permit.release();
  }
}

module('--changed flag', { concurrency: true }, () => {
  test('first run warms the metafile cache; second --changed with no edits skips all tests', async (assert) => {
    const project = await makeChangedProject();

    // Run 1: full build, no --changed. Populates the per-project metafile cache.
    const first = await runCli(project, 'test/');
    assert.exitCode(first, 0);
    assert.includes(first, '# pass 2');

    assert.ok(
      await fs
        .stat(MetafileCache.path(project.cwd))
        .then(() => true)
        .catch(() => false),
      'metafile cache written after first run',
    );

    // Run 2: --changed with HEAD === working tree. Filter resolves to 0 tests; exit 0 fast.
    const second = await runCli(project, 'test/ --changed');
    assert.exitCode(second, 0);
    assert.includes(second, '# Running 0 test files');
    assert.includes(second, '1..0');
    assert.notIncludes(second, '# pass');
  });

  test('--changed runs only tests whose imports include a changed source file', async (assert) => {
    const project = await makeChangedProject();

    // Warm the metafile.
    const first = await runCli(project, 'test/');
    assert.exitCode(first, 0);
    assert.includes(first, '# pass 2');

    // Modify only src/a.ts so that only test/a-test.ts is affected.
    await fs.writeFile(path.join(project.cwd, 'src/a.ts'), 'export const a = 1;\n// tweak\n');

    const second = await runCli(project, 'test/ --changed');
    assert.exitCode(second, 0);
    assert.includes(second, '1 of 2 test files affected');
    assert.includes(second, '# pass 1');
    assert.notIncludes(second, '# pass 2');
  });

  test('package.json change short-circuits to a full run with a warning', async (assert) => {
    const project = await makeChangedProject();

    await runCli(project, 'test/');
    await fs.writeFile(
      path.join(project.cwd, 'package.json'),
      JSON.stringify({ name: 'changed', version: '0.0.2', type: 'module' }),
    );

    const result = await runCli(project, 'test/ --changed');
    assert.exitCode(result, 0);
    assert.includes(result, 'blast-radius');
    assert.includes(result, '# pass 2');
  });

  test('--changed --watch scopes only the initial run to the affected files', async (assert) => {
    const project = await makeChangedProject();

    // Warm the metafile with a full run, then change only src/a.ts so a-test is affected.
    await runCli(project, 'test/');
    await fs.writeFile(path.join(project.cwd, 'src/a.ts'), 'export const a = 1;\n// tweak\n');

    // watch keeps the full fsTree (qa/save still see every file); only the first run is scoped.
    const stdout = await shellWatch(`node ${CWD}/cli.ts test/ --changed --watch`, {
      cwd: project.cwd,
      until: (buf) => buf.includes('Press "qq"'),
    });
    assert.includes(stdout, '1 of 2 test files affected');
    assert.includes(stdout, 'press "qa" to run all');
    assert.includes(stdout, '# pass 1');
    assert.notIncludes(stdout, '# pass 2');
  });
});
