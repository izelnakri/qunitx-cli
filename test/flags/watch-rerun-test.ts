import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';

const CLI = `${process.cwd()}/cli.ts`;

// Maximum time to wait for a child process to exit after SIGTERM before giving up.
const CHILD_EXIT_GRACE_MS = 5000;
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
  /** Resolves once `condition(accumulatedStdout)` returns true, or rejects after 90s. */
  waitFor(condition: (buf: string) => boolean, description?: string): Promise<string>;
  /** Sends SIGTERM and resolves once the child process has fully exited. */
  kill(): Promise<void>;
  readonly stdout: string;
}

// Spawns a long-running watch-mode process. Returns a session object that lets tests
// wait for incremental stdout output and kill the child when done.
async function spawnWatch(
  args: string[],
  { cwd = process.cwd(), timeout = 120000 }: { cwd?: string; timeout?: number } = {},
): Promise<WatchSession> {
  const outputDir = `${process.cwd()}/tmp/run-${randomUUID()}`;
  const allArgs = [CLI, ...args, `--output=${outputDir}`];
  if (QUNITX_BROWSER && !args.some((arg) => arg.startsWith('--browser'))) {
    allArgs.push(`--browser=${QUNITX_BROWSER}`);
  }

  const permit = await acquireBrowser();
  const child = spawn(process.execPath, allArgs, { cwd });
  let buf = '';
  const listeners: Array<(buf: string) => void> = [];

  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    for (const l of [...listeners]) l(buf);
  });
  child.stderr.resume();

  // Track unexpected exits so waitFor can reject immediately instead of hanging.
  let exitCode: number | null = null;
  let exitReject: ((err: Error) => void) | null = null;
  child.once('exit', (code) => {
    exitCode = code ?? 0;
    exitReject?.(
      new Error(
        `Watch process exited unexpectedly (code=${exitCode}). Last 500 chars:\n${buf.slice(-500)}`,
      ),
    );
    exitReject = null;
  });

  return {
    waitFor(condition, description) {
      if (condition(buf)) return Promise.resolve(buf);
      const what = description ? `waiting for '${description}'` : 'waiting for condition';
      if (exitCode !== null) {
        return Promise.reject(
          new Error(
            `Watch process already exited (code=${exitCode}) while ${what}. Last 500 chars:\n${buf.slice(-500)}`,
          ),
        );
      }
      return new Promise((resolve, reject) => {
        exitReject = reject;
        const timer = setTimeout(() => {
          // Remove the stale listener so it cannot fire exitReject = null on a future
          // waitFor call's reject function, silently breaking crash-detection.
          listeners.splice(listeners.indexOf(listener), 1);
          if (exitReject === reject) exitReject = null;
          reject(
            new Error(
              `spawnWatch timed out after ${timeout}ms while ${what}. Last 500 chars:\n${buf.slice(-500)}`,
            ),
          );
        }, timeout);
        const listener = (newBuf: string) => {
          if (condition(newBuf)) {
            clearTimeout(timer);
            exitReject = null;
            listeners.splice(listeners.indexOf(listener), 1);
            resolve(newBuf);
          }
        };
        listeners.push(listener);
      });
    },
    kill() {
      return new Promise<void>((resolve) => {
        // Safety valve: if the process hasn't exited in CHILD_EXIT_GRACE_MS, stop waiting.
        // Crucially: remove the 'exit' listener and unref() the child so the
        // ChildProcess handle no longer keeps the Node.js event loop alive.
        // Without this, a stuck child (rare but observed on CI) causes the
        // test runner to hang indefinitely after the test function resolves.
        const timer = setTimeout(() => {
          child.removeListener('exit', done);
          child.unref();
          permit.release();
          resolve();
        }, CHILD_EXIT_GRACE_MS);
        timer.unref();

        // Resolve after exit so the next test doesn't start until Chrome and the
        // HTTP server from this run are fully released (prevents resource contention
        // on CI where consecutive Chrome instances can starve the new one).
        const done = () => {
          clearTimeout(timer);
          permit.release();
          resolve();
        };
        child.once('exit', done);
        child.kill('SIGTERM');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      });
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

// Waits for the nth "QUnitX running:" header to appear, then waits for "# duration"
// to appear after it (i.e. the run has fully completed).
async function waitForRunComplete(
  session: WatchSession,
  minRunCount: number,
  label?: string,
): Promise<void> {
  await session.waitFor((buf) => countOccurrences(buf, 'QUnitX running:') >= minRunCount, label);
  await session.waitFor((buf) => buf.includes('# duration', buf.lastIndexOf('QUnitX running:')));
}

// Polls `fn` every `interval` ms until `predicate(result)` is true, then returns the result.
// Rejects with a descriptive error if `timeout` ms elapse without the predicate being satisfied.
async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  {
    interval = 50,
    timeout = 5000,
    label = 'condition',
  }: { interval?: number; timeout?: number; label?: string } = {},
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const result = await fn();
    if (predicate(result)) return result;
    if (Date.now() >= deadline)
      throw new Error(`pollUntil: ${label} not satisfied within ${timeout}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, interval));
  }
}

// Creates a project with an extra symlink .ts file inside tests/.
// The symlink points to a real file OUTSIDE the watched directory so that
// deleting the symlink does not also destroy the content.
async function makeWatchProjectWithSymlink(): Promise<{
  dir: string;
  id: string;
  testsDir: string;
  testFile: string;
  testContent: string;
  target: string;
  symlink: string;
  symlinkId: string;
}> {
  const project = await makeWatchProject();
  const symlinkId = randomUUID();
  const target = `${project.dir}/symlink-target.ts`; // outside tests/
  const symlink = `${project.testsDir}/symlink.ts`; // inside tests/ (watched)
  await fs.writeFile(target, project.testContent.replace(project.id, symlinkId));
  await fs.symlink(target, symlink);
  return { ...project, target, symlink, symlinkId };
}

module('--watch re-run tests', { concurrency: true }, () => {
  test('changing a file in watched directory triggers a re-run', async (assert) => {
    const { dir, id, testFile, testContent } = await makeWatchProject();
    // Watch the `tests/` directory so the file watcher resolves paths correctly.
    const session = await spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');
      assert.passingTestCaseFor(session.stdout, { moduleName: id });

      // Modify the file (append a harmless comment to trigger a 'change' event).
      await fs.writeFile(testFile, testContent + '\n// re-run trigger');

      await waitForRunComplete(session, 2, 're-run to start');

      assert.includes(session.stdout, 'CHANGED:');
      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      assert.includes(rerunOutput, '# pass 3');
      assert.includes(rerunOutput, '# fail 0');
    } finally {
      await session.kill();
    }
  });

  test('adding a new file to the watched directory triggers a filtered re-run', async (assert) => {
    const { dir, id, testsDir, testContent } = await makeWatchProject();
    const session = await spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');
      assert.passingTestCaseFor(session.stdout, { moduleName: id });

      // Add a second test file with its own unique module name.
      const newId = randomUUID();
      const newContent = testContent.replace(id, newId);
      await fs.writeFile(`${testsDir}/extra-tests.ts`, newContent);

      await waitForRunComplete(session, 2, 're-run to start');

      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      // Filtered run only executes the newly added file (3 tests).
      assert.includes(rerunOutput, '# pass 3');
      assert.includes(rerunOutput, '# fail 0');
      // The new file's module name appears in the filtered re-run output.
      assert.includes(rerunOutput, newId);
    } finally {
      await session.kill();
    }
  });

  test('deleting a file from the watched directory triggers a full re-run without it', async (assert) => {
    const { dir, id, testsDir, testContent } = await makeWatchProject();

    // Add a second test file so there is still something to run after deletion.
    const id2 = randomUUID();
    await fs.writeFile(`${testsDir}/extra-tests.ts`, testContent.replace(id, id2));

    const session = await spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      // Initial run: both files → 6 passing tests (all bundled together in watch mode).
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');
      assert.passingTestCaseFor(session.stdout, { moduleName: id });
      assert.passingTestCaseFor(session.stdout, { moduleName: id2 });

      // Delete the first test file.
      await fs.unlink(`${testsDir}/passing-tests.ts`);

      await waitForRunComplete(session, 2, 're-run to start');

      assert.includes(session.stdout, 'REMOVED:');
      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      // Only the second file's 3 tests run because the cache was cleared and rebuilt.
      assert.includes(rerunOutput, '# pass 3');
      assert.includes(rerunOutput, '# fail 0');
      // The deleted file's module name is absent; the remaining file's is present.
      assert.false(rerunOutput.includes(id), 'deleted file module absent from re-run output');
      assert.includes(rerunOutput, id2);
    } finally {
      await session.kill();
    }
  });

  test('renaming a file triggers remove+add and the renamed file is re-run', async (assert) => {
    const { dir, id, testsDir, testContent } = await makeWatchProject();

    // Second file so fsTree is non-empty after the renamed file's unlink fires first.
    const id2 = randomUUID();
    await fs.writeFile(`${testsDir}/extra-tests.ts`, testContent.replace(id, id2));

    const session = await spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');
      assert.passingTestCaseFor(session.stdout, { moduleName: id });
      assert.passingTestCaseFor(session.stdout, { moduleName: id2 });

      await fs.rename(`${testsDir}/passing-tests.ts`, `${testsDir}/renamed-tests.ts`);

      // REMOVED: and ADDED: are logged before the _building guard so they always appear.
      await session.waitFor(
        (buf) => buf.includes('REMOVED:') && buf.includes('ADDED:'),
        'REMOVED and ADDED events',
      );

      // Pending trigger: the add's filtered run fires after the unlink's full re-run completes.
      // Wait for both runs to complete (initial + at least 2 more: unlink full-run + add filtered-run).
      await waitForRunComplete(session, 3, 'unlink full-run + add filtered-run');

      // Final run is the filtered run of the renamed file — same content (id), passes.
      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      assert.includes(rerunOutput, '# fail 0');
      assert.includes(rerunOutput, id);
    } finally {
      await session.kill();
    }
  });

  test('renaming a watched directory removes its files from tracking', async (assert) => {
    const { dir, id, testsDir, testContent } = await makeWatchProject();

    // Second directory so there is still something to run after the rename.
    const otherDir = `${dir}/other-tests`;
    const id2 = randomUUID();
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(`${otherDir}/other-tests.ts`, testContent.replace(id, id2));

    const session = await spawnWatch(['tests', 'other-tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');
      assert.passingTestCaseFor(session.stdout, { moduleName: id });
      assert.passingTestCaseFor(session.stdout, { moduleName: id2 });

      // Rename tests/ — parent watcher detects disappearance and fires unlinkDir.
      await fs.rename(testsDir, `${dir}/old-tests`);

      await session.waitFor(
        (buf) => buf.includes('REMOVED:'),
        'REMOVED event for renamed directory',
      );
      await waitForRunComplete(session, 2, 're-run to start');

      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      // Only the other-tests file runs — renamed directory's files are no longer tracked.
      assert.includes(rerunOutput, id2);
      assert.false(rerunOutput.includes(id), 'renamed-away directory files absent from re-run');
    } finally {
      await session.kill();
    }
  });

  test('rapid file changes coalesce: only the final state is tested', async (assert) => {
    const { dir, id, testFile, testContent } = await makeWatchProject();
    const session = await spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');
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
      }, 'final coalesced re-run with finalId to complete');

      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      // The final state (finalId) ran — no crash, no broken intermediate state.
      assert.includes(rerunOutput, '# fail 0');
      assert.includes(rerunOutput, finalId);
    } finally {
      await session.kill();
    }
  });

  test('simultaneous writes to files in two watched directories both appear in the rebuild', async (assert) => {
    const {
      dir,
      id: id1,
      testsDir: testsDir1,
      testFile: testFile1,
      testContent,
    } = await makeWatchProject();

    // Second watched directory shares the same project root (node_modules symlink, package.json).
    const testsDir2 = `${dir}/tests2`;
    const id2 = randomUUID();
    const content2 = testContent.replace(id1, id2);
    const testFile2 = `${testsDir2}/extra-tests.ts`;
    await fs.mkdir(testsDir2, { recursive: true });
    await fs.writeFile(testFile2, content2);

    const session = await spawnWatch(['tests', 'tests2', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');
      assert.passingTestCaseFor(session.stdout, { moduleName: id1 });
      assert.passingTestCaseFor(session.stdout, { moduleName: id2 });

      // Write to both files at the same time. The two separate fs.watch instances can
      // deliver their change events at different times: the first event starts a full
      // rebuild while the second queues as a pending trigger and fires after. On slower
      // CI environments both new IDs may therefore appear across two consecutive runs
      // rather than a single one. Wait for both IDs anywhere in the accumulated output.
      const newId1 = randomUUID();
      const newId2 = randomUUID();
      await Promise.all([
        fs.writeFile(testFile1, testContent.replace(id1, newId1)),
        fs.writeFile(testFile2, content2.replace(id2, newId2)),
      ]);

      await session.waitFor(
        (buf) => buf.includes(newId1) && buf.includes(newId2),
        'both new module IDs appear in output',
      );

      assert.includes(session.stdout, newId1);
      assert.includes(session.stdout, newId2);
      assert.includes(session.stdout, '# fail 0');
    } finally {
      await session.kill();
    }
  });

  test('removing one of multiple watched directories fires REMOVED exactly once and leaves the other watcher active', async (assert) => {
    const { dir, id: id1, testsDir: testsDir1, testContent } = await makeWatchProject();

    const testsDir2 = `${dir}/tests2`;
    const id2 = randomUUID();
    const content2 = testContent.replace(id1, id2);
    const testFile2 = `${testsDir2}/extra-tests.ts`;
    await fs.mkdir(testsDir2, { recursive: true });
    await fs.writeFile(testFile2, content2);

    const session = await spawnWatch(['tests', 'tests2', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');
      assert.passingTestCaseFor(session.stdout, { moduleName: id1 });
      assert.passingTestCaseFor(session.stdout, { moduleName: id2 });

      // Rename tests/ away — the parent watcher fires a 'rename' event (Linux: IN_MOVED_FROM +
      // IN_MOVED_TO appear as two separate events). The parentUnlinkFired guard ensures unlinkDir
      // fires exactly once even if both arrive before the async stat() check completes.
      await fs.rename(testsDir1, `${dir}/old-tests`);

      await session.waitFor(
        (buf) => buf.includes('REMOVED:'),
        'REMOVED event for renamed directory',
      );
      await waitForRunComplete(session, 2, 're-run to start after removal');

      // Removed directory's files are absent; remaining directory's files are present.
      const afterRemoval = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      assert.false(afterRemoval.includes(id1), 'removed directory module absent from re-run');
      assert.includes(afterRemoval, id2);

      // REMOVED: must appear exactly once — verifies the parentUnlinkFired double-fire fix.
      assert.equal(
        countOccurrences(session.stdout, 'REMOVED:'),
        1,
        'REMOVED: printed exactly once',
      );

      // Verify the remaining watcher (tests2/) is still functional after the removal.
      const newId2 = randomUUID();
      await fs.writeFile(testFile2, content2.replace(id2, newId2));

      await waitForRunComplete(session, 3, 'second re-run to start');

      assert.includes(session.stdout, newId2);
    } finally {
      await session.kill();
    }
  });

  test('renaming a nested subdirectory fires one REMOVED event and re-runs with remaining files across all watched paths', async (assert) => {
    // Scenario: multiple watched dirs, one of which has a deep nested structure.
    // Renaming a subdirectory inside a watched path fires a single 'rename' event for the
    // directory itself (not individual events per file). The child watcher must detect that
    // the renamed path has tracked children and fire one unlinkDir — not silently ignore it.
    const { dir, id: rootId, testsDir, testContent } = await makeWatchProject();

    // Nested structure inside tests/:
    //   tests/subdir/nested1.ts   (nestedId1)
    //   tests/subdir/nested2.ts   (nestedId2)
    //   tests/subdir/deeper/deep.ts (deepId)
    const subdir = `${testsDir}/subdir`;
    const deeper = `${subdir}/deeper`;
    await fs.mkdir(deeper, { recursive: true });
    const nestedId1 = randomUUID();
    const nestedId2 = randomUUID();
    const deepId = randomUUID();
    await fs.writeFile(`${subdir}/nested1.ts`, testContent.replace(rootId, nestedId1));
    await fs.writeFile(`${subdir}/nested2.ts`, testContent.replace(rootId, nestedId2));
    await fs.writeFile(`${deeper}/deep.ts`, testContent.replace(rootId, deepId));

    // Second watched directory (separate from tests/).
    const testsDir2 = `${dir}/tests2`;
    const id2 = randomUUID();
    await fs.mkdir(testsDir2, { recursive: true });
    await fs.writeFile(`${testsDir2}/extra.ts`, testContent.replace(rootId, id2));

    const session = await spawnWatch(['tests', 'tests2', '--watch'], { cwd: dir });

    try {
      // Initial run: 5 modules × 3 tests = 15 tests.
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');
      assert.passingTestCaseFor(session.stdout, { moduleName: rootId });
      assert.passingTestCaseFor(session.stdout, { moduleName: nestedId1 });
      assert.passingTestCaseFor(session.stdout, { moduleName: nestedId2 });
      assert.passingTestCaseFor(session.stdout, { moduleName: deepId });
      assert.passingTestCaseFor(session.stdout, { moduleName: id2 });

      // Rename tests/subdir/ away — fires ONE 'rename' event for the directory itself.
      // The child watcher detects tracked children and fires a single unlinkDir.
      await fs.rename(subdir, `${dir}/old-subdir`);

      await session.waitFor((buf) => buf.includes('REMOVED:'), 'REMOVED event for renamed subdir');
      await waitForRunComplete(session, 2, 're-run to start');

      // Re-run must include tests/root.ts and tests2/extra.ts only (6 tests).
      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      assert.includes(rerunOutput, '# pass 6');
      assert.includes(rerunOutput, '# fail 0');
      assert.includes(rerunOutput, rootId);
      assert.includes(rerunOutput, id2);
      assert.false(rerunOutput.includes(nestedId1), 'subdir files absent from re-run');
      assert.false(rerunOutput.includes(nestedId2), 'subdir files absent from re-run');
      assert.false(rerunOutput.includes(deepId), 'deeper files absent from re-run');

      // Exactly one REMOVED: must appear — the directory rename fires one child-watcher
      // 'rename' event which the new unlinkDir detection coalesces into a single event,
      // rather than N separate unlink events for each file inside the directory.
      assert.equal(
        countOccurrences(session.stdout, 'REMOVED:'),
        1,
        'exactly one REMOVED: for the whole renamed subdirectory',
      );
    } finally {
      await session.kill();
    }
  });

  test('a build error in watch mode prints the error without exiting', async (assert) => {
    const { dir, id, testFile, testContent } = await makeWatchProject();
    const session = await spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      // Wait for the initial passing run.
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');
      assert.passingTestCaseFor(session.stdout, { moduleName: id });

      // Overwrite the file with invalid syntax that esbuild cannot bundle.
      await fs.writeFile(testFile, 'this is not valid typescript !!@#$%^&*');

      // Wait for the bundle error message to appear.
      await session.waitFor(
        (buf) => buf.includes('esbuild Bundle Error:'),
        'esbuild Bundle Error to appear',
      );
      assert.includes(session.stdout, 'esbuild Bundle Error:');

      // Fix the file — a still-alive process will pick this up and re-run.
      await fs.writeFile(testFile, testContent);

      await waitForRunComplete(session, 2, 're-run after fix to start');

      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      assert.includes(rerunOutput, '# pass 3');
      assert.includes(rerunOutput, '# fail 0');
    } finally {
      await session.kill();
    }
  });

  // ── Symlink tests ────────────────────────────────────────────────────────────────────────────
  // Background: on Linux, fs.unlink on a symlink fires NO fs.watch rename events (unlike regular
  // files). The watcher compensates with fs.watchFile polling (500 ms interval). All symlink
  // deletion tests therefore wait up to 3 s for the polling cycle to fire.
  // fs.readdir withFileTypes reports symlinks as isSymbolicLink(), not isFile(), so buildFSTree
  // previously excluded them from the initial scan; that bug is also covered here.

  test('a symlink to a .ts file present at startup is tracked and its module runs', async (assert) => {
    // Verifies the buildFSTree fix: symlinks inside the watched directory are included in the
    // initial fsTree scan and therefore bundled in the first run.
    const { dir, id, symlinkId } = await makeWatchProjectWithSymlink();
    const session = await spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');
      // Both the regular test file and the symlinked file must be in the initial bundle.
      assert.passingTestCaseFor(session.stdout, { moduleName: id });
      assert.passingTestCaseFor(session.stdout, { moduleName: symlinkId });
    } finally {
      await session.kill();
    }
  });

  test('adding a symlink to a .ts file into the watched directory triggers a filtered re-run', async (assert) => {
    // fs.watch fires a rename event when a symlink is created; classifyRenameEvent follows the
    // symlink via stat() and classifies it as 'add', triggering a filtered re-run.
    const { dir, id, testsDir, testContent } = await makeWatchProject();
    const session = await spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');
      assert.passingTestCaseFor(session.stdout, { moduleName: id });

      const symlinkId = randomUUID();
      const target = `${dir}/new-target.ts`;
      await fs.writeFile(target, testContent.replace(id, symlinkId));
      await fs.symlink(target, `${testsDir}/new-symlink.ts`);

      await waitForRunComplete(session, 2, 'symlink add re-run to start');

      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      assert.includes(rerunOutput, symlinkId);
      assert.includes(rerunOutput, '# fail 0');
    } finally {
      await session.kill();
    }
  });

  test('writing through a symlink (modifying its target) triggers a re-run', async (assert) => {
    // writeFile on a symlink path opens and modifies the TARGET file. On Linux this fires
    // rename events for the symlink name, which the change deduplicator handles normally.
    const { dir, id, symlink, target, testContent, symlinkId } =
      await makeWatchProjectWithSymlink();
    const session = await spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');
      assert.passingTestCaseFor(session.stdout, { moduleName: symlinkId });

      const newId = randomUUID();
      await fs.writeFile(symlink, testContent.replace(id, newId)); // writes through symlink to target

      await waitForRunComplete(session, 2, 'symlink write-through re-run to start');

      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      assert.includes(rerunOutput, newId);
      assert.includes(rerunOutput, '# fail 0');
    } finally {
      await session.kill();
    }
  });

  test('deleting a symlink .ts file triggers a full re-run without it', async (assert) => {
    // fs.unlink on a symlink fires NO fs.watch events on Linux. The watcher uses fs.watchFile
    // polling (500 ms interval) to detect the deletion.
    const { dir, id, symlink, symlinkId } = await makeWatchProjectWithSymlink();
    const session = await spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');
      assert.passingTestCaseFor(session.stdout, { moduleName: id });
      assert.passingTestCaseFor(session.stdout, { moduleName: symlinkId });

      await fs.unlink(symlink);

      // Poll detection fires within ~500 ms; use a 3 s cap to keep CI stable.
      await waitForRunComplete(session, 2, 'symlink deletion re-run to start');

      assert.includes(session.stdout, 'REMOVED:');
      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      assert.includes(rerunOutput, id);
      assert.false(rerunOutput.includes(symlinkId), 'deleted symlink module absent from re-run');
    } finally {
      await session.kill();
    }
  });

  test('deleting the target of a symlink (making it dangling) triggers a full re-run', async (assert) => {
    // When the symlink's target is removed, stat() on the symlink path starts failing.
    // The fs.watchFile poll detects nlink === 0 and fires 'unlink' for the symlink path.
    const { dir, id, symlink, target, symlinkId } = await makeWatchProjectWithSymlink();
    const session = await spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');
      assert.passingTestCaseFor(session.stdout, { moduleName: symlinkId });

      // Delete the target (outside the watched dir). The symlink in tests/ becomes dangling.
      await fs.unlink(target);

      await waitForRunComplete(session, 2, 'dangling symlink re-run to start');

      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      assert.includes(rerunOutput, id);
      assert.false(rerunOutput.includes(symlinkId), 'dangling symlink module absent from re-run');
    } finally {
      await session.kill();
    }
  });

  test('renaming a symlink fires an immediate add then a polling-delayed unlink', async (assert) => {
    // Unlike regular file renames (where both unlink and add come from fs.watch immediately),
    // a symlink rename fires only the destination rename event via fs.watch — the source's
    // disappearance is detected by the fs.watchFile poll ~500 ms later.
    // This test verifies both mechanisms compose correctly.
    const { dir, id, testsDir, symlink, symlinkId, testContent } =
      await makeWatchProjectWithSymlink();
    const session = await spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');
      assert.passingTestCaseFor(session.stdout, { moduleName: id });
      assert.passingTestCaseFor(session.stdout, { moduleName: symlinkId });

      // Rename the symlink within the watched dir. fs.watch fires 'rename' for the destination
      // (add), while the source's removal is detected only by the fs.watchFile poll (~500 ms).
      const renamedSymlink = `${testsDir}/renamed-symlink.ts`;
      await fs.rename(symlink, renamedSymlink);

      // The add fires first — wait for the filtered re-run of the renamed symlink.
      await session.waitFor((buf) => buf.includes('ADDED:'), 'ADDED event for renamed symlink');
      await waitForRunComplete(session, 2, 'filtered re-run after add');

      // The unlink fires later via polling — wait for a second re-run.
      await session.waitFor((buf) => buf.includes('REMOVED:'), 'REMOVED event via polling');
      await waitForRunComplete(session, 3, 'full re-run after polling unlink');

      const rerunOutput = session.stdout.slice(session.stdout.lastIndexOf('QUnitX running:'));
      // Final state: renamed symlink's content (same symlinkId) present, original path gone.
      assert.includes(rerunOutput, symlinkId);
      assert.includes(rerunOutput, '# fail 0');
    } finally {
      await session.kill();
    }
  });

  test('a dangling symlink added to the watched directory is silently ignored', async (assert) => {
    // classifyRenameEvent: stat() fails on the dangling symlink, path is not in fsTree → null.
    // No re-run, no crash, no ADDED: in output.
    const { dir, id, testsDir } = await makeWatchProject();
    const session = await spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => buf.includes('Press "qq"'), 'initial run to complete');

      await fs.symlink(`${dir}/nonexistent.ts`, `${testsDir}/dangling.ts`);

      // Give the watcher time to process. If a spurious re-run fires, waitForRunComplete
      // would capture it and the ADDED: assertion below would catch the mistake.
      await new Promise<void>((resolve) => setTimeout(resolve, 800));

      assert.equal(
        countOccurrences(session.stdout, 'QUnitX running:'),
        1,
        'no extra run triggered by dangling symlink',
      );
      assert.false(session.stdout.includes('ADDED:'), 'no ADDED: logged for dangling symlink');
    } finally {
      await session.kill();
    }
  });

  test('build error in watch mode serves error HTML at / until the file is fixed', async (assert) => {
    const { dir, testFile, testContent } = await makeWatchProject();
    let port: number | null = null;
    const session = await spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => {
        const match = buf.match(/http:\/\/localhost:(\d+)/);
        if (match && port === null) port = Number(match[1]);
        return buf.includes('Press "qq"');
      }, 'initial run to complete');

      // Trigger a build error
      await fs.writeFile(testFile, 'this is not valid typescript !!@#$%^&*');
      await session.waitFor(
        (buf) => buf.includes('esbuild Bundle Error:'),
        'build error to appear',
      );

      // Poll until / serves the error HTML.
      // Race: a single fs.writeFile can produce two inotify events. The second queues as a
      // pending-trigger rebuild that clears _buildError = null at its start before re-setting
      // it after the second failure. A single fetch right after 'esbuild Bundle Error:'
      // appears in stdout can land in that brief null window and receive normal HTML.
      const errorBody = await pollUntil(
        () => fetch(`http://localhost:${port}/`).then((r) => r.text()),
        (body) => body.includes('Build Error:'),
        { interval: 50, timeout: 5000, label: 'error HTML at /' },
      );
      assert.includes(errorBody, 'Build Error:', 'error HTML served at / after build error');
      assert.includes(errorBody, '<html', 'response is HTML, not a TAP stream');

      // Fix the file — error clears, normal page returns
      await fs.writeFile(testFile, testContent);
      await waitForRunComplete(session, 2, 're-run after fix');

      const okBody = await fetch(`http://localhost:${port}/`).then((r) => r.text());
      assert.notIncludes(okBody, 'Build Error:', 'error HTML cleared at / after fix');
    } finally {
      await session.kill();
    }
  });

  test('build error in watch mode sends a WebSocket refresh message to connected clients', async (assert) => {
    const { dir, testFile, testContent } = await makeWatchProject();
    let port: number | null = null;
    const session = await spawnWatch(['tests', '--watch'], { cwd: dir });

    try {
      await session.waitFor((buf) => {
        const match = buf.match(/http:\/\/localhost:(\d+)/);
        if (match && port === null) port = Number(match[1]);
        return buf.includes('Press "qq"');
      }, 'initial run to complete');

      const messages: string[] = [];
      // Callbacks waiting for the next 'refresh' message. Drained and called on each arrival.
      const refreshWaiters: Array<() => void> = [];

      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('WS connect failed'));
      });
      ws.onmessage = (e) => {
        const data = typeof e.data === 'string' ? e.data : String(e.data);
        messages.push(data);
        if (data === 'refresh') {
          const waiting = refreshWaiters.splice(0);
          for (const cb of waiting) cb();
        }
      };

      // Resolves as soon as messages contains at least n 'refresh' entries, or rejects after 5 s.
      // Checks immediately so it never sleeps when the message has already arrived.
      function waitForNRefreshes(n: number): Promise<void> {
        const count = () => messages.filter((m) => m === 'refresh').length;
        if (count() >= n) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`timed out waiting for ${n} refresh message(s)`)),
            5000,
          );
          const check = () => {
            if (count() >= n) {
              clearTimeout(timer);
              resolve();
            } else {
              refreshWaiters.push(check);
            }
          };
          refreshWaiters.push(check);
        });
      }

      try {
        // Trigger the error and wait reactively for the first refresh — no fixed sleep.
        // A single fs.writeFile can produce two inotify events; the second queues as a
        // pending trigger. waitForNRefreshes(1) resolves on the first, and
        // refreshCountAfterError captures however many actually fired.
        await fs.writeFile(testFile, 'this is not valid typescript !!@#$%^&*');
        await session.waitFor(
          (buf) => buf.includes('esbuild Bundle Error:'),
          'build error to appear',
        );
        await waitForNRefreshes(1);

        const refreshCountAfterError = messages.filter((m) => m === 'refresh').length;
        assert.ok(refreshCountAfterError >= 1, 'refresh sent to WS client on build error');

        // Fix the file. onFinishFunc fires after runTestsInBrowser returns (after '# duration'
        // appears). Wait reactively for one more refresh rather than sleeping.
        await fs.writeFile(testFile, testContent);
        await waitForRunComplete(session, 2, 're-run after fix');
        await waitForNRefreshes(refreshCountAfterError + 1);

        assert.ok(
          messages.filter((m) => m === 'refresh').length > refreshCountAfterError,
          'additional refresh sent to WS client after successful rebuild',
        );
      } finally {
        ws.close();
      }
    } finally {
      await session.kill();
    }
  });
});
