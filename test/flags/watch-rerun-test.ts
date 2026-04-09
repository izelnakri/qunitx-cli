import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';

const CLI = `${process.cwd()}/cli.ts`;
const QUNITX_BROWSER = process.env.QUNITX_BROWSER;

// Count non-overlapping occurrences of `needle` in `str`.
function countOccurrences(str: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = str.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

interface WatchSession {
  /** Resolves once `condition(accumulatedStdout)` returns true, or rejects after 45s. */
  waitFor(condition: (buf: string) => boolean): Promise<string>;
  kill(): void;
  readonly stdout: string;
}

// Spawns a long-running watch-mode process. Returns a session object that lets tests
// wait for incremental stdout output and kill the child when done.
function spawnWatch(
  args: string[],
  { cwd = process.cwd(), timeout = 45000 }: { cwd?: string; timeout?: number } = {},
): WatchSession {
  const outputDir = `${process.cwd()}/tmp/run-${randomUUID()}`;
  const allArgs = ['--experimental-strip-types', CLI, ...args, `--output=${outputDir}`];
  if (QUNITX_BROWSER && !args.some((a) => a.startsWith('--browser'))) {
    allArgs.push(`--browser=${QUNITX_BROWSER}`);
  }

  const child = spawn(process.execPath, allArgs, { cwd });
  let buf = '';
  const listeners: Array<(buf: string) => void> = [];

  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    for (const l of [...listeners]) l(buf);
  });
  child.stderr.resume();

  return {
    waitFor(condition) {
      if (condition(buf)) return Promise.resolve(buf);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `spawnWatch timed out after ${timeout}ms. Last 500 chars:\n${buf.slice(-500)}`,
              ),
            ),
          timeout,
        );
        const listener = (newBuf: string) => {
          if (condition(newBuf)) {
            clearTimeout(timer);
            listeners.splice(listeners.indexOf(listener), 1);
            resolve(newBuf);
          }
        };
        listeners.push(listener);
      });
    },
    kill() {
      child.kill('SIGTERM');
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    },
    get stdout() {
      return buf;
    },
  };
}

// Creates a temp project whose tests live under a `tests/` subdirectory so the
// file watcher watches a directory (not a file). This is required because
// `fs.watch` on a directory correctly resolves `path.join(watchPath, filename)`
// whereas watching an individual file produces an incorrect joined path.
async function makeWatchProject(): Promise<{
  dir: string;
  id: string;
  testsDir: string;
  testFile: string;
  testContent: string;
}> {
  const id = randomUUID();
  const dir = `${process.cwd()}/tmp/${id}`;
  const testsDir = `${dir}/tests`;
  await fs.mkdir(testsDir, { recursive: true });
  const [template] = await Promise.all([
    fs.readFile(`${process.cwd()}/test/helpers/passing-tests.ts`),
    fs.symlink(`${process.cwd()}/node_modules`, `${dir}/node_modules`),
    fs.writeFile(
      `${dir}/package.json`,
      JSON.stringify({ name: id, version: '0.0.1', type: 'module' }),
    ),
  ]);
  const testContent = template.toString().replace('{{moduleName}}', id);
  const testFile = `${testsDir}/passing-tests.ts`;
  await fs.writeFile(testFile, testContent);

  return { dir, id, testsDir, testFile, testContent };
}

module('--watch re-run tests', () => {
  test('changing a file in watched directory triggers a re-run', async (assert) => {
    const { dir, id, testFile, testContent } = await makeWatchProject();
    // Watch the `tests/` directory so the file watcher resolves paths correctly.
    const session = spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      // Wait for the initial run to complete.
      await session.waitFor((buf) => buf.includes('Press "qq"'));

      assert.passingTestCaseFor(session.stdout, { moduleName: id });

      // Modify the file (append a harmless comment to trigger a 'change' event).
      await fs.writeFile(testFile, testContent + '\n// re-run trigger');

      // Each test run prints one "QUnitX running:" line; wait for the second one.
      await session.waitFor((buf) => countOccurrences(buf, 'QUnitX running:') >= 2);

      // Wait for the re-run's TAP summary to appear after the second run header.
      await session.waitFor((buf) => {
        const idx = buf.lastIndexOf('QUnitX running:');
        return buf.includes('# duration', idx);
      });

      assert.includes(session.stdout, 'CHANGED:');
      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      assert.includes(rerunOutput, '# pass 3');
      assert.includes(rerunOutput, '# fail 0');
    } finally {
      session.kill();
    }
  });

  test('adding a new file to the watched directory triggers a filtered re-run', async (assert) => {
    const { dir, id, testsDir, testContent } = await makeWatchProject();
    const session = spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      // Wait for the initial run to complete.
      await session.waitFor((buf) => buf.includes('Press "qq"'));

      assert.passingTestCaseFor(session.stdout, { moduleName: id });

      // Add a second test file with its own unique module name.
      const newId = randomUUID();
      const newContent = testContent.replace(id, newId);
      await fs.writeFile(`${testsDir}/extra-tests.ts`, newContent);

      // Wait for the filtered re-run triggered by the new file.
      await session.waitFor((buf) => countOccurrences(buf, 'QUnitX running:') >= 2);
      await session.waitFor((buf) => {
        const idx = buf.lastIndexOf('QUnitX running:');
        return buf.includes('# duration', idx);
      });

      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      // Filtered run only executes the newly added file (3 tests).
      assert.includes(rerunOutput, '# pass 3');
      assert.includes(rerunOutput, '# fail 0');
      // The new file's module name appears in the filtered re-run output.
      assert.includes(rerunOutput, newId);
    } finally {
      session.kill();
    }
  });

  test('deleting a file from the watched directory triggers a full re-run without it', async (assert) => {
    const { dir, id, testsDir, testContent } = await makeWatchProject();

    // Add a second test file so there is still something to run after deletion.
    const id2 = randomUUID();
    await fs.writeFile(`${testsDir}/extra-tests.ts`, testContent.replace(id, id2));

    const session = spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      // Initial run: both files → 6 passing tests (all bundled together in watch mode).
      await session.waitFor((buf) => buf.includes('Press "qq"'));

      assert.passingTestCaseFor(session.stdout, { moduleName: id });
      assert.passingTestCaseFor(session.stdout, { moduleName: id2 });

      // Delete the first test file.
      await fs.unlink(`${testsDir}/passing-tests.ts`);

      // Wait for the full re-run (unlink path in run.ts → cache cleared → rebuild).
      await session.waitFor((buf) => countOccurrences(buf, 'QUnitX running:') >= 2);
      await session.waitFor((buf) => {
        const idx = buf.lastIndexOf('QUnitX running:');
        return buf.includes('# duration', idx);
      });

      assert.includes(session.stdout, 'REMOVED:');
      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      // Only the second file's 3 tests run because the cache was cleared and rebuilt.
      assert.includes(rerunOutput, '# pass 3');
      assert.includes(rerunOutput, '# fail 0');
      // The deleted file's module name is absent; the remaining file's is present.
      assert.false(rerunOutput.includes(id), 'deleted file module absent from re-run output');
      assert.includes(rerunOutput, id2);
    } finally {
      session.kill();
    }
  });

  test('renaming a file triggers remove+add and the renamed file is re-run', async (assert) => {
    const { dir, id, testsDir, testContent } = await makeWatchProject();

    // Second file so fsTree is non-empty after the renamed file's unlink fires first.
    const id2 = randomUUID();
    await fs.writeFile(`${testsDir}/extra-tests.ts`, testContent.replace(id, id2));

    const session = spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'));
      assert.passingTestCaseFor(session.stdout, { moduleName: id });
      assert.passingTestCaseFor(session.stdout, { moduleName: id2 });

      await fs.rename(`${testsDir}/passing-tests.ts`, `${testsDir}/renamed-tests.ts`);

      // REMOVED: and ADDED: are logged before the _building guard so they always appear.
      await session.waitFor((buf) => buf.includes('REMOVED:') && buf.includes('ADDED:'));

      // Pending trigger: the add's filtered run fires after the unlink's full re-run completes.
      // Wait for both runs to complete (initial + at least 2 more: unlink full-run + add filtered-run).
      await session.waitFor((buf) => countOccurrences(buf, 'QUnitX running:') >= 3);
      await session.waitFor((buf) => {
        const idx = buf.lastIndexOf('QUnitX running:');
        return buf.includes('# duration', idx);
      });

      // Final run is the filtered run of the renamed file — same content (id), passes.
      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      assert.includes(rerunOutput, '# fail 0');
      assert.includes(rerunOutput, id);
    } finally {
      session.kill();
    }
  });

  test('renaming a watched directory removes its files from tracking', async (assert) => {
    const { dir, id, testsDir, testContent } = await makeWatchProject();

    // Second directory so there is still something to run after the rename.
    const otherDir = `${dir}/other-tests`;
    const id2 = randomUUID();
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(`${otherDir}/other-tests.ts`, testContent.replace(id, id2));

    const session = spawnWatch(['tests', 'other-tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'));
      assert.passingTestCaseFor(session.stdout, { moduleName: id });
      assert.passingTestCaseFor(session.stdout, { moduleName: id2 });

      // Rename tests/ — parent watcher detects disappearance and fires unlinkDir.
      await fs.rename(testsDir, `${dir}/old-tests`);

      await session.waitFor((buf) => buf.includes('REMOVED:'));
      await session.waitFor((buf) => countOccurrences(buf, 'QUnitX running:') >= 2);
      await session.waitFor((buf) => {
        const idx = buf.lastIndexOf('QUnitX running:');
        return buf.includes('# duration', idx);
      });

      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      // Only the other-tests file runs — renamed directory's files are no longer tracked.
      assert.includes(rerunOutput, id2);
      assert.false(rerunOutput.includes(id), 'renamed-away directory files absent from re-run');
    } finally {
      session.kill();
    }
  });

  test('rapid file changes coalesce: only the final state is tested', async (assert) => {
    const { dir, id, testFile, testContent } = await makeWatchProject();
    const session = spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'));
      assert.passingTestCaseFor(session.stdout, { moduleName: id });

      // Write the file three times in quick succession. The pending-trigger mechanism
      // ensures the last write wins: intermediate builds are coalesced.
      const finalId = randomUUID();
      await fs.writeFile(testFile, testContent + '\n// intermediate 1');
      await fs.writeFile(testFile, testContent + '\n// intermediate 2');
      await fs.writeFile(testFile, testContent.replace(id, finalId));

      // Wait until finalId has actually appeared in a completed run.
      // Using count >= 2 is not enough: the first re-run may show an intermediate state while
      // the pending trigger's build (which reads finalId) hasn't finished yet.
      await session.waitFor((buf) => {
        const idx = buf.indexOf(finalId);
        return idx !== -1 && buf.includes('# duration', idx);
      });

      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      // The final state (finalId) ran — no crash, no broken intermediate state.
      assert.includes(rerunOutput, '# fail 0');
      assert.includes(rerunOutput, finalId);
    } finally {
      session.kill();
    }
  });

  test('a build error in watch mode prints the error without exiting', async (assert) => {
    const { dir, id, testFile, testContent } = await makeWatchProject();
    const session = spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      // Wait for the initial passing run.
      await session.waitFor((buf) => buf.includes('Press "qq"'));

      assert.passingTestCaseFor(session.stdout, { moduleName: id });

      // Overwrite the file with invalid syntax that esbuild cannot bundle.
      await fs.writeFile(testFile, 'this is not valid typescript !!@#$%^&*');

      // Wait for the bundle error message to appear.
      await session.waitFor((buf) => buf.includes('esbuild Bundle Error:'));
      assert.includes(session.stdout, 'esbuild Bundle Error:');

      // Fix the file — a still-alive process will pick this up and re-run.
      await fs.writeFile(testFile, testContent);

      await session.waitFor((buf) => countOccurrences(buf, 'QUnitX running:') >= 2);
      await session.waitFor((buf) => {
        const idx = buf.lastIndexOf('QUnitX running:');
        return buf.includes('# duration', idx);
      });

      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      assert.includes(rerunOutput, '# pass 3');
      assert.includes(rerunOutput, '# fail 0');
    } finally {
      session.kill();
    }
  });
});
