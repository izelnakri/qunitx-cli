import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import * as FileWatcher from '../../lib/setup/file-watcher.ts';
import '../helpers/custom-asserts.ts';
import * as RunState from '../../lib/setup/run-state.ts';
import type { Config, FSTree, RunState as RunStateShape } from '../../lib/types.ts';

const sha1 = (content: string) => createHash('sha1').update(content).digest('hex');

// Ad-hoc test configs omit most of Config; attach default run state so the watcher's state.watch
// bookkeeping is always present. Attached in place rather than copied so successive calls share
// one state object and the test can assert on what the watcher accumulated. Cases that need
// seeded values pass their own via watchState().
const asConfig = (config: object): Config => {
  const withState = config as Config;
  withState.state ??= RunState.create();
  return withState;
};

// Fresh run state with the watcher's build bookkeeping overridden. These tests drive
// handleWatchEvent directly, so they seed the slots a real run would have accumulated.
const watchState = (overrides: Partial<RunStateShape['watch']> = {}): RunStateShape => {
  const state = RunState.create();
  Object.assign(state.watch, overrides);
  return state;
};

module('Setup | FileWatcher.toWatchableRoot', { concurrency: true }, () => {
  test('a real directory or file is returned unchanged', (assert) => {
    assert.equal(FileWatcher.toWatchableRoot(process.cwd()), process.cwd());
    const self = path.join(process.cwd(), 'test/setup/file-watcher-test.ts');
    assert.equal(FileWatcher.toWatchableRoot(self), self);
  });

  test('a glob collapses to its deepest existing ancestor directory', (assert) => {
    assert.equal(
      FileWatcher.toWatchableRoot(path.join(process.cwd(), 'test/setup/**/!(x).ts')),
      path.join(process.cwd(), 'test/setup'),
    );
  });

  test('a path whose whole chain is missing floors at cwd, never the filesystem root', (assert) => {
    // Unreachable for real cwd-joined inputs, but fs.watch on a root would recursively watch the
    // entire disk — so the degenerate case must floor at cwd.
    const root = path.parse(process.cwd()).root;
    const result = FileWatcher.toWatchableRoot(
      path.join(root, 'no-such-dir-xyz', 'deeper', '**', '*.ts'),
    );
    assert.equal(result, process.cwd());
    assert.notEqual(result, root);
  });
});

// ---------------------------------------------------------------------------
// readFileStable — the Windows write-race fix
// ---------------------------------------------------------------------------

module('Setup | FileWatcher.readFileStable', { concurrency: true }, () => {
  // Reproduces the flake: on Windows fs.writeFile truncates then writes, and the 'change' event
  // can fire at truncate, so a single read catches the 0-byte window. The change handler hashed
  // that empty snapshot and rebuilt it — esbuild bundled a file with no test() calls, printing
  // "0 tests registered" (test/flags/watch-rerun-test.ts, run 29508249303 on windows-latest).
  test('returns the settled content, not a mid-write truncate snapshot', async (assert) => {
    // A read landing in the truncate window sees empty; the next read (window passed) sees the
    // real bytes. A single read — the old behavior — would have hashed the empty first snapshot.
    const snapshots = [Buffer.from(''), Buffer.from('test("a", () => {})')];
    let reads = 0;
    const stubRead = () => Promise.resolve(snapshots[Math.min(reads++, snapshots.length - 1)]);

    const result = await FileWatcher.readFileStable('x.ts', stubRead);

    assert.equal(
      snapshots[0].toString(),
      '',
      'a single read would have returned this empty snapshot (the bug)',
    );
    assert.equal(
      result.toString(),
      'test("a", () => {})',
      'readFileStable waited for the bytes to land',
    );
  });

  test('fast path: content already stable returns after one confirming read', async (assert) => {
    let reads = 0;
    const stubRead = () => {
      reads++;
      return Promise.resolve(Buffer.from('stable'));
    };

    const result = await FileWatcher.readFileStable('x.ts', stubRead);

    assert.equal(result.toString(), 'stable', 'returns the content');
    assert.equal(
      reads,
      2,
      'one read plus one confirming read — no retry loop when already settled',
    );
  });

  test('gives up after the attempt cap and returns the latest content', async (assert) => {
    // A file under continuous rewrite never stabilizes; the helper must proceed, not loop forever.
    let reads = 0;
    const stubRead = () => Promise.resolve(Buffer.from(`content-${reads++}`));

    const result = await FileWatcher.readFileStable('x.ts', stubRead);

    assert.ok(
      result.toString().startsWith('content-'),
      'returned the latest read rather than hanging',
    );
  });
});

// ---------------------------------------------------------------------------
// mutateFSTree
// ---------------------------------------------------------------------------

module('Setup | FileWatcher.mutateFSTree', { concurrency: true }, () => {
  test('add inserts path', (assert) => {
    const fsTree = {};
    FileWatcher.mutateFSTree(fsTree, 'add', '/project/test/foo.js');
    assert.deepEqual(fsTree, { '/project/test/foo.js': null });
  });

  test('unlink removes path', (assert) => {
    const fsTree = { '/project/test/foo.js': null };
    FileWatcher.mutateFSTree(fsTree, 'unlink', '/project/test/foo.js');
    assert.deepEqual(fsTree, {});
  });

  test('unlinkDir removes all entries under the directory', (assert) => {
    const fsTree = {
      '/project/test/foo.js': null,
      '/project/test/bar.js': null,
      '/project/other/baz.js': null,
    };
    FileWatcher.mutateFSTree(fsTree, 'unlinkDir', '/project/test');
    assert.deepEqual(fsTree, { '/project/other/baz.js': null });
  });

  test('unlinkDir does not remove sibling directories that share a name prefix', (assert) => {
    // Regression: startsWith('/project/test') also matched '/project/test2/...' etc.
    // The fix appends '/' so only entries strictly inside the directory are deleted.
    const fsTree = {
      '/project/test/foo.js': null,
      '/project/test2/bar.js': null,
      '/project/testcases/baz.js': null,
      '/project/other/qux.js': null,
    };
    FileWatcher.mutateFSTree(fsTree, 'unlinkDir', '/project/test');
    assert.deepEqual(fsTree, {
      '/project/test2/bar.js': null,
      '/project/testcases/baz.js': null,
      '/project/other/qux.js': null,
    });
  });
});

// ---------------------------------------------------------------------------
// handleWatchEvent
// ---------------------------------------------------------------------------

module('Setup | FileWatcher.handleWatchEvent', { concurrency: true }, () => {
  test('change event triggers onEventFunc', (assert) => {
    const config = { fsTree: { '/project/test/foo.js': null }, projectRoot: '/project' };
    assert.deepEqual(trackCalls(config, 'change', '/project/test/foo.js'), [
      { event: 'change', path: '/project/test/foo.js' },
    ]);
  });

  test('add event updates fsTree and triggers onEventFunc', (assert) => {
    const config = { fsTree: {}, projectRoot: '/project' };
    trackCalls(config, 'add', '/project/test/new.ts');
    assert.deepEqual(config.fsTree, { '/project/test/new.ts': null });
  });

  test('unlink removes file from fsTree', (assert) => {
    const config = { fsTree: { '/project/test/gone.js': null }, projectRoot: '/project' };
    const calls = trackCalls(config, 'unlink', '/project/test/gone.js');
    assert.deepEqual(config.fsTree, {});
    assert.equal(calls.length, 1);
  });

  test('unlinkDir bypasses extension filter and removes all files under the directory', (assert) => {
    const config = {
      fsTree: {
        '/project/test/unit/foo.js': null,
        '/project/test/unit/bar.ts': null,
        '/project/test/integration/baz.js': null,
      },
      projectRoot: '/project',
    };
    const calls = trackCalls(config, 'unlinkDir', '/project/test/unit');
    assert.deepEqual(config.fsTree, { '/project/test/integration/baz.js': null });
    assert.deepEqual(calls, [{ event: 'unlinkDir', path: '/project/test/unit' }]);
  });

  test('unlinkDir on a nested subdirectory removes its subtree and leaves siblings untouched', (assert) => {
    // Verifies both the mutateFSTree prefix fix and that handleWatchEvent coalesces
    // a nested directory removal into a single onEventFunc call.
    const config = {
      fsTree: {
        '/project/tests/subdir/nested1.ts': null,
        '/project/tests/subdir/nested2.ts': null,
        '/project/tests/subdir/deeper/deep.ts': null,
        '/project/tests/root.ts': null,
        '/project/tests2/extra.ts': null,
      },
      projectRoot: '/project',
    };
    const calls = trackCalls(config, 'unlinkDir', '/project/tests/subdir');
    assert.deepEqual(config.fsTree, {
      '/project/tests/root.ts': null,
      '/project/tests2/extra.ts': null,
    });
    assert.deepEqual(calls, [{ event: 'unlinkDir', path: '/project/tests/subdir' }]);
  });

  test('unlinkDir with no matching files leaves fsTree unchanged but still calls onEventFunc', (assert) => {
    const config = { fsTree: { '/project/other/baz.js': null }, projectRoot: '/project' };
    assert.equal(trackCalls(config, 'unlinkDir', '/project/test').length, 1);
    assert.deepEqual(config.fsTree, { '/project/other/baz.js': null });
  });

  test('non-matching file extension is ignored', (assert) => {
    const config = { fsTree: {}, projectRoot: '/project' };
    assert.equal(trackCalls(config, 'change', '/project/styles/app.css').length, 0);
  });

  test('event while a build is active queues a pending trigger instead of calling onEventFunc', (assert) => {
    const config = {
      fsTree: { '/project/test/foo.js': null },
      projectRoot: '/project',
      state: watchState({ building: true }),
    };
    assert.equal(trackCalls(config, 'change', '/project/test/foo.js').length, 0);
  });

  test('spurious change for a just-added file is ignored while building', (assert) => {
    // Post-add inotify flush: rename (→ add) fires first, then change fires after the file
    // content hits disk. The add's build is still running, so the change must not queue a
    // full re-run as a pending trigger.
    const config = {
      fsTree: { '/project/test/new.ts': null },
      projectRoot: '/project',
      state: watchState({ building: true, justAddedFiles: new Set(['/project/test/new.ts']) }),
    };
    assert.equal(trackCalls(config, 'change', '/project/test/new.ts').length, 0);
    assert.notOk(config.state.watch.pendingBuildTrigger, 'no pending trigger queued');
  });

  test('second add while building tracks the file so its spurious change is filtered', (assert) => {
    // Two files added rapidly: the second goes through the pending-trigger path. It must also
    // be in _justAddedFiles so its post-add change does not overwrite the pending trigger.
    const config = {
      fsTree: { '/project/test/first.ts': null },
      projectRoot: '/project',
      state: watchState({ building: true, justAddedFiles: new Set(['/project/test/first.ts']) }),
    };

    trackCalls(config, 'add', '/project/test/second.ts');
    assert.ok(
      config.state.watch.justAddedFiles?.has('/project/test/second.ts'),
      'tracked in justAddedFiles',
    );
    assert.ok(config.state.watch.pendingBuildTrigger, 'pending trigger set');

    const pendingTrigger = config.state.watch.pendingBuildTrigger;
    trackCalls(config, 'change', '/project/test/second.ts');
    assert.equal(
      config.state.watch.pendingBuildTrigger,
      pendingTrigger,
      'pending trigger not overwritten',
    );
  });

  test('custom extension .mjs triggers onEventFunc', (assert) => {
    const config = { fsTree: {}, projectRoot: '/project' };
    trackCalls(config, 'add', '/project/test/new.mjs', ['mjs']);
    assert.deepEqual(config.fsTree, { '/project/test/new.mjs': null });
  });

  test('custom extension: .js ignored when extensions only includes mjs', (assert) => {
    const config = { fsTree: {}, projectRoot: '/project' };
    assert.equal(trackCalls(config, 'add', '/project/test/new.js', ['mjs']).length, 0);
  });

  test('lastBuildEndMs is set after an async build completes', async (assert) => {
    const config = { fsTree: { '/project/test/foo.js': null }, projectRoot: '/project' };
    const done = FileWatcher.handleWatchEvent(
      asConfig(config),
      ['js', 'ts'],
      'change',
      '/project/test/foo.js',
      () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
      null,
    );
    assert.notOk(config.state.watch.lastBuildEndMs, 'not set while in progress');
    assert.equal(config.state.watch.building, true);
    await done;
    assert.equal(config.state.watch.building, false);
    assert.ok(config.state.watch.lastBuildEndMs <= Date.now(), 'set to a valid timestamp');
  });

  test('lastBuildEndMs is set even when the build throws', async (assert) => {
    const config = { fsTree: { '/project/test/foo.js': null }, projectRoot: '/project' };
    await FileWatcher.handleWatchEvent(
      asConfig(config),
      ['js', 'ts'],
      'change',
      '/project/test/foo.js',
      () => Promise.reject(new Error('simulated failure')),
      null,
    );
    assert.equal(config.state.watch.building, false);
    assert.ok(config.state.watch.lastBuildEndMs);
  });

  test('lastBuildEndMs is NOT set when onEventFunc returns synchronously', async (assert) => {
    const config = { fsTree: { '/project/test/foo.js': null }, projectRoot: '/project' };
    await FileWatcher.handleWatchEvent(
      asConfig(config),
      ['js', 'ts'],
      'change',
      '/project/test/foo.js',
      () => undefined,
      null,
    );
    assert.notOk(config.state.watch.lastBuildEndMs);
    assert.equal(config.state.watch.building, false);
  });

  test('CHANGED: log shows the full absolute path for files outside projectRoot', (assert) => {
    // Regression guard: the original code used `filePath.split(config.projectRoot)[1]`, which
    // returns undefined when filePath doesn't contain projectRoot. The fix uses startsWith/slice.
    // console.log('#', colorEvent(event), displayPath) — the path is always the third arg.
    const config = { fsTree: { '/tmp/external.ts': null }, projectRoot: '/project' };
    const logged: unknown[][] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logged.push(args);
    try {
      trackCalls(config, 'change', '/tmp/external.ts');
    } finally {
      console.log = origLog;
    }
    const allOutput = logged.flat().map(String).join(' ');
    assert.includes(allOutput, '/tmp/external.ts');
    assert.notIncludes(allOutput, 'undefined');
  });

  test('onFinishFunc receives (filePath, event) — path first, event second', async (assert) => {
    // Regression: the call was onFinishFunc(event, filePath) — args were swapped.
    const config = { fsTree: { '/project/test/foo.js': null }, projectRoot: '/project' };
    const calls: Array<[string, string]> = [];
    await FileWatcher.handleWatchEvent(
      asConfig(config),
      ['js', 'ts'],
      'change',
      '/project/test/foo.js',
      () => Promise.resolve(),
      (p, ev) => calls.push([p, ev]),
    );
    assert.deepEqual(calls, [['/project/test/foo.js', 'change']]);
  });

  test('change after a just-completed add is suppressed (Windows flake reproducer)', async (assert) => {
    // Windows fs.watch fires both a rename (→ classified as 'add') AND one or more
    // spurious 'change' events for a single fs.writeFile of a new file. The 'add'
    // correctly triggers a filtered rebuild; the trailing 'change' must be suppressed
    // — otherwise it fires a redundant FULL rebuild that races the filtered one and
    // can stomp the user-visible re-run output. Reproduces the failure at
    // test/flags/watch-rerun-test.ts:38 ("adding a new file ... triggers a filtered re-run").
    const config = { fsTree: {}, projectRoot: '/project' };
    const calls: Array<{ event: string; path: string }> = [];
    const onEvent = (ev: string, p: string): Promise<void> => {
      calls.push({ event: ev, path: p });
      return Promise.resolve();
    };

    await FileWatcher.handleWatchEvent(
      asConfig(config),
      ['ts'],
      'add',
      '/project/test/new.ts',
      onEvent,
      null,
    );
    // Spurious change immediately after the add's build completes (Windows behaviour).
    await FileWatcher.handleWatchEvent(
      asConfig(config),
      ['ts'],
      'change',
      '/project/test/new.ts',
      onEvent,
      null,
    );

    assert.deepEqual(
      calls,
      [{ event: 'add', path: '/project/test/new.ts' }],
      'only the add fires; trailing change is suppressed',
    );
  });

  test('lastBuildEndMs advances on each successive build', async (assert) => {
    const config = { fsTree: { '/project/test/foo.js': null }, projectRoot: '/project' };
    const asyncBuild = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

    await FileWatcher.handleWatchEvent(
      asConfig(config),
      ['js', 'ts'],
      'change',
      '/project/test/foo.js',
      asyncBuild,
      null,
    );
    const firstEndMs = config.state.watch.lastBuildEndMs;
    assert.ok(firstEndMs);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await FileWatcher.handleWatchEvent(
      asConfig(config),
      ['js', 'ts'],
      'change',
      '/project/test/foo.js',
      asyncBuild,
      null,
    );
    assert.ok(config.state.watch.lastBuildEndMs > firstEndMs);
  });

  test('a failed build drops the file content-hash baseline so a revert to built content re-fires', async (assert) => {
    // Regression (120s macOS watch hang): a build-error write can arrive as an fs.watch 'rename'
    // that fires the rebuild without advancing builtContentHash. Reverting the file to its last
    // successfully-built content then hashes identically to the stale baseline and is suppressed as
    // a no-op, so watch mode never re-runs the fix. The build-error branch must drop the entry.
    const file = '/project/test/foo.ts';
    const config = {
      fsTree: { [file]: null },
      projectRoot: '/project',
      state: watchState({ builtContentHash: { [file]: sha1('valid content') } }),
    };
    // buildTestBundle sets build.lastBuildErrored on an esbuild failure (see tests-in-browser.ts).
    await FileWatcher.handleWatchEvent(
      asConfig(config),
      ['ts'],
      'change',
      file,
      () => {
        config.state.group.build.lastBuildErrored = true;
        return Promise.resolve();
      },
      null,
    );
    assert.notOk(
      config.state.watch.builtContentHash[file],
      'baseline dropped after a failed build',
    );
  });

  test('a clean build keeps the file content-hash baseline (no spurious re-fire)', async (assert) => {
    const file = '/project/test/foo.ts';
    const config = {
      fsTree: { [file]: null },
      projectRoot: '/project',
      state: watchState({ builtContentHash: { [file]: sha1('built content') } }),
    };
    await FileWatcher.handleWatchEvent(
      asConfig(config),
      ['ts'],
      'change',
      file,
      () => {
        config.state.group.build.lastBuildErrored = false;
        return Promise.resolve();
      },
      null,
    );
    assert.equal(
      config.state.watch.builtContentHash[file],
      sha1('built content'),
      'baseline preserved',
    );
  });
});

// ---------------------------------------------------------------------------
// FileWatcher.setup
// ---------------------------------------------------------------------------

module('Setup | FileWatcher.setup', { concurrency: true }, () => {
  test('seeds config.state.watch.lastBuildEndMs at startup so the rescan has a baseline', async (assert) => {
    // The initial build runs from run.ts directly (not through handleWatchEvent), so without
    // this seed lastBuildEndMs would stay 0 after a failed initial build — and the macOS
    // rescan could not distinguish stale from genuinely-modified files. Locking the seed in
    // here protects against future refactors that move the assignment elsewhere.
    const config = asConfig({
      fsTree: {},
      projectRoot: process.cwd(),
      extensions: ['ts'],
    });
    const before = Date.now();
    const { killFileWatchers, ready } = FileWatcher.setup(
      [], // empty lookup paths — no actual fs.watch handles created
      config,
      () => {},
      null,
    );
    try {
      await ready;
      assert.ok(typeof config.state.watch.lastBuildEndMs === 'number', 'set to a number');
      assert.ok(
        config.state.watch.lastBuildEndMs! >= before,
        '>= the moment FileWatcher.setup was called',
      );
      assert.ok(config.state.watch.lastBuildEndMs! <= Date.now(), '<= the moment we observed it');
    } finally {
      killFileWatchers();
    }
  });

  test('preserves an already-set config.state.watch.lastBuildEndMs', async (assert) => {
    // Defensive: if a caller has already seeded the timestamp (e.g. a rebuild happened
    // before the watcher was reinitialized), FileWatcher.setup must not clobber it.
    const config = {
      fsTree: {},
      projectRoot: process.cwd(),
      extensions: ['ts'],
      state: watchState({ lastBuildEndMs: 12345 }),
    } as unknown as Config;
    const { killFileWatchers, ready } = FileWatcher.setup([], config, () => {}, null);
    try {
      await ready;
      assert.equal(config.state.watch.lastBuildEndMs, 12345, 'pre-existing value preserved');
    } finally {
      killFileWatchers();
    }
  });

  test('change on a directly-watched file passes the correct path to onEventFunc, not a doubled path', async (assert) => {
    // Regression: when watchPath is a file (not a directory), fs.watch fires events with
    // filename = the file's own basename. path.join(watchPath, filename) produced the
    // nonsense doubled path "test/foo.ts/foo.ts" which is never in fsTree, so the guard
    // "if (event === 'change' && !(file in fsTree)) return" silently swallowed every
    // change event and no rebuild ever fired.
    const tmpFile = path.join(process.cwd(), `tmp/watch-direct-file-${randomUUID()}.ts`);
    await fs.mkdir(path.join(process.cwd(), 'tmp'), { recursive: true });
    await fs.writeFile(tmpFile, 'export const a = 1;');

    const config = { fsTree: { [tmpFile]: null }, projectRoot: process.cwd(), extensions: ['ts'] };
    const seen: Array<{ event: string; file: string }> = [];
    let resolve!: () => void;
    const settled = new Promise<void>((r) => (resolve = r));

    const { killFileWatchers, ready } = FileWatcher.setup(
      [tmpFile], // file path, not a directory — the case that triggered the bug
      asConfig(config),
      (event, file) => {
        seen.push({ event, file });
        resolve();
      },
      null,
    );

    try {
      await ready;
      await fs.writeFile(tmpFile, 'export const a = 2;');

      // Without the fix, settled never resolves — the change event is swallowed.
      await Promise.race([
        settled,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('no change event within 2s')), 2000),
        ),
      ]);

      assert.equal(seen[0].event, 'change');
      assert.equal(seen[0].file, tmpFile, 'correct path, not doubled');
      assert.notEqual(
        seen[0].file,
        path.join(tmpFile, path.basename(tmpFile)),
        'doubled path absent',
      );
    } finally {
      killFileWatchers();
      await fs.rm(tmpFile, { force: true });
    }
  });

  test('single writeFile: handler reads final content (mid-write race guard)', async (assert) => {
    // Reproducer for test/flags/watch-rerun-test.ts:407 flake on Windows. The real-world
    // scenario is a single fs.writeFile (editor save, test-fixture restore). fs.writeFile
    // is not atomic — it open()s with truncation, then write()s, then close()s. Without the
    // debounce, fs.watch can fire 'change' between the truncate and the write, the handler
    // reads `""`, and the rebuild bundles an empty file → "0 tests registered" in CI.
    //
    // The debounce in FileWatcher.setup waits CHANGE_COALESCE_MS (50ms) after the last
    // event, by which point fs.writeFile's close() has finished and the file is fully
    // written. Each handler invocation then reads the final content.
    //
    // (We don't stress-test with a rapid `for` loop of writes here: each iteration's
    // `await fs.writeFile` yields to the event loop, letting the debounce timer fire
    // mid-loop and racing the handler's fs.readFile against the next iteration's
    // truncate-and-write. That is a test artefact, not the bug — real watch scenarios are
    // single writes.)
    const tmpDir = path.join(process.cwd(), 'tmp', `coalesce-${randomUUID()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, 'a.ts');
    await fs.writeFile(tmpFile, 'export const a = 0;');

    const config = { fsTree: { [tmpFile]: null }, projectRoot: process.cwd(), extensions: ['ts'] };
    const seen: string[] = [];
    let onFirstEvent!: () => void;
    const firstEvent = new Promise<void>((resolve) => (onFirstEvent = resolve));

    const { killFileWatchers, ready } = FileWatcher.setup(
      [tmpDir],
      asConfig(config),
      async (_event, file) => {
        seen.push(await fs.readFile(file, 'utf8'));
        onFirstEvent();
      },
      null,
    );

    try {
      await ready;
      await fs.writeFile(tmpFile, 'export const a = 42;');

      // Wait event-driven for the first handler invocation, racing against a generous
      // timeout — macOS FSEvents delivers events with higher latency than inotify, and CI
      // runners under load can delay even further (a fixed 500ms tripped the assertion
      // locally on macOS once the runner was busy). Promise.race exits the moment the
      // handler fires; the timeout is the upper bound, never the typical wait.
      await Promise.race([firstEvent, new Promise<void>((r) => setTimeout(r, 5000))]);
      // Brief settle pause to capture any follow-up events the kernel queues after the
      // first one, so we assert on the final-state set rather than the first arrival.
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      assert.ok(seen.length >= 1, `handler fired at least once (got ${seen.length})`);
      // The actual bug: a mid-write event reads an empty file. With the debounce, every
      // call should see the final content — no empties, no partial reads.
      for (const content of seen) {
        assert.equal(
          content,
          'export const a = 42;',
          `every call reads the final content (got ${JSON.stringify(seen)})`,
        );
      }
    } finally {
      killFileWatchers();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// rescanDirectoryForDelta
// ---------------------------------------------------------------------------

module('Setup | FileWatcher.rescanDirectoryForDelta', { concurrency: true }, () => {
  test('fires add for a new regular file not yet in fsTree', async (assert) => {
    const dir = path.join(process.cwd(), `tmp/rescan-add-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const newFile = path.join(dir, 'new-test.ts');
    await fs.writeFile(newFile, 'export default {}');

    const config: Partial<Config> & { fsTree: FSTree } = { fsTree: {}, projectRoot: dir };
    const events: Array<{ event: string; file: string }> = [];

    await FileWatcher.rescanDirectoryForDelta(
      dir,
      asConfig(config),
      ['ts', 'js'],
      (ev, f) => events.push({ event: ev, file: f }),
      null,
    );

    try {
      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'add');
      assert.equal(events[0].file, newFile);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('fires add for a new symlink not yet in fsTree', async (assert) => {
    // The specific macOS failure: a symlink was created but fs.watch fired null filename.
    const dir = path.join(process.cwd(), `tmp/rescan-symlink-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, 'target.ts');
    const symlink = path.join(dir, 'link.ts');
    await fs.writeFile(target, 'export default {}');
    await fs.symlink(target, symlink);

    const config: Partial<Config> & { fsTree: FSTree } = { fsTree: {}, projectRoot: dir };
    const events: Array<{ event: string; file: string }> = [];

    await FileWatcher.rescanDirectoryForDelta(
      dir,
      asConfig(config),
      ['ts', 'js'],
      (ev, f) => events.push({ event: ev, file: f }),
      null,
    );

    try {
      assert.ok(
        events.some((e) => e.event === 'add' && e.file === symlink),
        'symlink detected as add event',
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('fires change when a tracked file content differs from the built baseline', async (assert) => {
    // When FSEvents drops a 'change' event under load, the rescan must catch the missed
    // modification — otherwise the watcher sits forever on stale content (a 120-second timeout).
    // Detection is by content hash, not mtime.
    const dir = path.join(process.cwd(), `tmp/rescan-change-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const tracked = path.join(dir, 'tracked.ts');
    await fs.writeFile(tracked, 'before');
    await fs.writeFile(tracked, 'after');

    const config: Partial<Config> & { fsTree: FSTree } = {
      fsTree: { [tracked]: null },
      projectRoot: dir,
      state: watchState({
        lastBuildEndMs: Date.now(),
        builtContentHash: { [tracked]: sha1('before') },
      }),
    };
    const events: Array<{ event: string; file: string }> = [];

    await FileWatcher.rescanDirectoryForDelta(
      dir,
      asConfig(config),
      ['ts', 'js'],
      (ev, f) => events.push({ event: ev, file: f }),
      null,
    );

    try {
      assert.equal(events.length, 1, 'exactly one event fires');
      assert.equal(events[0].event, 'change', 'event is a change, not add or unlink');
      assert.equal(events[0].file, tracked);
      assert.equal(
        config.state.watch.builtContentHash![tracked],
        sha1('after'),
        'baseline advanced',
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('does not fire change when the tracked file content matches the built baseline', async (assert) => {
    // At startup the rescan must not fire spurious change events for pre-existing untouched
    // files — their content hashes identically to the seeded baseline, even though their mtime
    // sits inside the grace window.
    const dir = path.join(process.cwd(), `tmp/rescan-nochange-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const tracked = path.join(dir, 'untouched.ts');
    await fs.writeFile(tracked, 'content');

    const config: Partial<Config> & { fsTree: FSTree } = {
      fsTree: { [tracked]: null },
      projectRoot: dir,
      state: watchState({
        lastBuildEndMs: Date.now(),
        builtContentHash: { [tracked]: sha1('content') },
      }),
    };
    const events: Array<{ event: string; file: string }> = [];

    await FileWatcher.rescanDirectoryForDelta(
      dir,
      asConfig(config),
      ['ts', 'js'],
      (ev, f) => events.push({ event: ev, file: f }),
      null,
    );

    try {
      assert.equal(events.length, 0, 'no event fires for unchanged content');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('fires a same-second rewrite whose content differs but mtime is unchanged', async (assert) => {
    // The macOS/webkit "rapid file changes coalesce" hang: the intermediate and final writes of
    // a burst land in the same 1-second mtime bucket, so mtime can't distinguish them — and the
    // final write also completes WHILE a slow webkit build is still running, so its mtime even
    // predates _lastBuildEndMs. The old `mtime > _lastBuildEndMs` rescan gate dropped it forever,
    // leaving the final state untested. Content-hash detection must still fire for it.
    const dir = path.join(process.cwd(), `tmp/rescan-samesecond-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const tracked = path.join(dir, 'tracked.ts');
    await fs.writeFile(tracked, 'built content');
    const { mtimeMs } = await fs.stat(tracked);
    // Rewrite with DIFFERENT content but pin the SAME mtime — simulates the 1s-resolution
    // collision where the final write is indistinguishable from the built one by mtime.
    await fs.writeFile(tracked, 'final content');
    await fs.utimes(tracked, new Date(mtimeMs), new Date(mtimeMs));

    const config: Partial<Config> & { fsTree: FSTree } = {
      fsTree: { [tracked]: null },
      projectRoot: dir,
      // A slow (webkit) build ended AFTER this write, so its mtime predates the build end —
      // exactly the case the old mtime gate dropped.
      state: watchState({
        lastBuildEndMs: mtimeMs + 1000,
        builtContentHash: { [tracked]: sha1('built content') },
      }),
    };
    const events: Array<{ event: string; file: string }> = [];

    await FileWatcher.rescanDirectoryForDelta(
      dir,
      asConfig(config),
      ['ts', 'js'],
      (ev, f) => events.push({ event: ev, file: f }),
      null,
    );

    try {
      assert.equal(events.length, 1, 'the differing final content fires despite identical mtime');
      assert.equal(events[0].event, 'change');
      assert.equal(
        config.state.watch.builtContentHash![tracked],
        sha1('final content'),
        'baseline advanced',
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('does not re-add files already present in fsTree', async (assert) => {
    const dir = path.join(process.cwd(), `tmp/rescan-nodup-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const existing = path.join(dir, 'existing.ts');
    const newFile = path.join(dir, 'new.ts');
    await Promise.all([fs.writeFile(existing, ''), fs.writeFile(newFile, '')]);

    const config: Partial<Config> & { fsTree: FSTree } = {
      fsTree: { [existing]: null },
      projectRoot: dir,
    };
    const events: Array<{ event: string; file: string }> = [];

    await FileWatcher.rescanDirectoryForDelta(
      dir,
      asConfig(config),
      ['ts', 'js'],
      (ev, f) => events.push({ event: ev, file: f }),
      null,
    );

    try {
      assert.equal(events.length, 1, 'only the new file fires an event');
      assert.equal(events[0].file, newFile);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('ignores files with non-matching extensions', async (assert) => {
    const dir = path.join(process.cwd(), `tmp/rescan-ext-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(dir, 'style.css'), ''),
      fs.writeFile(path.join(dir, 'test.ts'), ''),
    ]);

    const config: Partial<Config> & { fsTree: FSTree } = { fsTree: {}, projectRoot: dir };
    const events: Array<{ event: string; file: string }> = [];

    await FileWatcher.rescanDirectoryForDelta(
      dir,
      asConfig(config),
      ['ts'],
      (ev, f) => events.push({ event: ev, file: f }),
      null,
    );

    try {
      assert.equal(events.length, 1, 'only .ts file fires event');
      assert.ok(events[0].file.endsWith('.ts'));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('detects new files in nested subdirectories', async (assert) => {
    const dir = path.join(process.cwd(), `tmp/rescan-nested-${randomUUID()}`);
    const nested = path.join(dir, 'sub', 'deep');
    await fs.mkdir(nested, { recursive: true });
    const deepFile = path.join(nested, 'deep-test.ts');
    await fs.writeFile(deepFile, '');

    const config: Partial<Config> & { fsTree: FSTree } = { fsTree: {}, projectRoot: dir };
    const events: Array<{ event: string; file: string }> = [];

    await FileWatcher.rescanDirectoryForDelta(
      dir,
      asConfig(config),
      ['ts'],
      (ev, f) => events.push({ event: ev, file: f }),
      null,
    );

    try {
      assert.equal(events.length, 1);
      assert.equal(events[0].file, deepFile);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('fires unlink for a tracked file that no longer exists on disk', async (assert) => {
    // The macOS null-filename deletion case: FSEvents fires rename with filename=null because
    // a file was deleted. rescanDirectoryForDelta must detect the missing file and fire unlink
    // so the stale fsTree entry is removed and the next build doesn't fail with "file not found".
    const dir = path.join(process.cwd(), `tmp/rescan-unlink-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const deleted = path.join(dir, 'deleted.ts');
    const remaining = path.join(dir, 'remaining.ts');
    await Promise.all([fs.writeFile(deleted, ''), fs.writeFile(remaining, '')]);
    await fs.rm(deleted);

    const config: Partial<Config> & { fsTree: FSTree } = {
      fsTree: { [deleted]: null, [remaining]: null },
      projectRoot: dir,
    };
    const events: Array<{ event: string; file: string }> = [];

    await FileWatcher.rescanDirectoryForDelta(
      dir,
      asConfig(config),
      ['ts', 'js'],
      (ev, f) => events.push({ event: ev, file: f }),
      null,
    );

    try {
      assert.equal(events.length, 1, 'exactly one unlink event fired');
      assert.equal(events[0].event, 'unlink');
      assert.equal(events[0].file, deleted);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('fires both add and unlink when a swap occurs in a single null-filename event', async (assert) => {
    // Models the scenario where two changes happen simultaneously (one file deleted, one added)
    // and FSEvents coalesces them into a single null-filename event.
    const dir = path.join(process.cwd(), `tmp/rescan-swap-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const deleted = path.join(dir, 'old.ts');
    const added = path.join(dir, 'new.ts');
    await fs.writeFile(deleted, '');
    // At time of rescan: old.ts gone from disk, new.ts present on disk
    await fs.rm(deleted);
    await fs.writeFile(added, '');

    const config: Partial<Config> & { fsTree: FSTree } = {
      fsTree: { [deleted]: null },
      projectRoot: dir,
    };
    const events: Array<{ event: string; file: string }> = [];

    await FileWatcher.rescanDirectoryForDelta(
      dir,
      asConfig(config),
      ['ts'],
      (ev, f) => events.push({ event: ev, file: f }),
      null,
    );

    try {
      assert.ok(
        events.some((e) => e.event === 'unlink' && e.file === deleted),
        'deleted file fires unlink',
      );
      assert.ok(
        events.some((e) => e.event === 'add' && e.file === added),
        'new file fires add',
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('fires unlinkDir (not individual unlinks) when a tracked subdirectory has been renamed away', async (assert) => {
    // Regression: rescanDirectoryForDelta fired one 'unlink' per tracked file inside the
    // renamed subdir, producing N REMOVED: log lines. The fix walks up the directory tree to
    // find the highest missing ancestor within watchPath and fires a single unlinkDir instead.
    const dir = path.join(process.cwd(), `tmp/rescan-unlinkdir-${randomUUID()}`);
    const subdir = path.join(dir, 'subdir');
    const deeper = path.join(subdir, 'deeper');
    await fs.mkdir(deeper, { recursive: true });
    const file1 = path.join(subdir, 'nested1.ts');
    const file2 = path.join(subdir, 'nested2.ts');
    const file3 = path.join(deeper, 'deep.ts');
    const remaining = path.join(dir, 'root.ts');
    await Promise.all([
      fs.writeFile(file1, ''),
      fs.writeFile(file2, ''),
      fs.writeFile(file3, ''),
      fs.writeFile(remaining, ''),
    ]);
    await fs.rename(subdir, path.join(dir, 'old-subdir'));

    const config: Partial<Config> & { fsTree: FSTree } = {
      fsTree: { [file1]: null, [file2]: null, [file3]: null, [remaining]: null },
      projectRoot: dir,
    };
    const events: Array<{ event: string; file: string }> = [];

    await FileWatcher.rescanDirectoryForDelta(
      dir,
      asConfig(config),
      ['ts', 'js'],
      (ev, f) => events.push({ event: ev, file: f }),
      null,
    );

    try {
      const removalEvents = events.filter((e) => e.event === 'unlink' || e.event === 'unlinkDir');
      assert.equal(removalEvents.length, 1, 'exactly one removal event');
      assert.equal(
        removalEvents[0].event,
        'unlinkDir',
        'removal is unlinkDir, not individual unlinks',
      );
      assert.equal(removalEvents[0].file, subdir, 'unlinkDir targets the renamed directory');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('silently succeeds when watchPath does not exist', async (assert) => {
    const config: Partial<Config> & { fsTree: FSTree } = { fsTree: {}, projectRoot: '/tmp' };
    const events: Array<{ event: string; file: string }> = [];

    await FileWatcher.rescanDirectoryForDelta(
      '/tmp/nonexistent-dir-that-does-not-exist-qunitx',
      asConfig(config),
      ['ts'],
      (ev, f) => events.push({ event: ev, file: f }),
      null,
    );

    assert.equal(events.length, 0, 'no events fired for missing directory');
  });
});

// Calls handleWatchEvent synchronously and returns the collected (event, path) pairs.
// Supplies default run state so cases that don't care about build bookkeeping can pass a bare
// `{ fsTree, projectRoot }`; cases that do pass their own via watchState().
function trackCalls(config: object, event: string, filePath: string, ext = ['js', 'ts']) {
  const calls: Array<{ event: string; path: string }> = [];
  FileWatcher.handleWatchEvent(
    asConfig(config),
    ext,
    event,
    filePath,
    (ev, p) => calls.push({ event: ev, path: p }),
    null,
  );
  return calls;
}
