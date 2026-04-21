import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  setupFileWatchers,
  mutateFSTree,
  handleWatchEvent,
  rescanDirectoryForDelta,
} from '../../lib/setup/file-watcher.ts';
import '../helpers/custom-asserts.ts';
import type { Config, FSTree } from '../../lib/types.ts';

// Calls handleWatchEvent synchronously and returns the collected (event, path) pairs.
function trackCalls(config: object, event: string, filePath: string, ext = ['js', 'ts']) {
  const calls: Array<{ event: string; path: string }> = [];
  handleWatchEvent(
    config as Config,
    ext,
    event,
    filePath,
    (ev, p) => calls.push({ event: ev, path: p }),
    null,
  );
  return calls;
}

// ---------------------------------------------------------------------------
// mutateFSTree
// ---------------------------------------------------------------------------

module('Setup | mutateFSTree', { concurrency: true }, () => {
  test('add inserts path', (assert) => {
    const fsTree = {};
    mutateFSTree(fsTree, 'add', '/project/test/foo.js');
    assert.deepEqual(fsTree, { '/project/test/foo.js': null });
  });

  test('unlink removes path', (assert) => {
    const fsTree = { '/project/test/foo.js': null };
    mutateFSTree(fsTree, 'unlink', '/project/test/foo.js');
    assert.deepEqual(fsTree, {});
  });

  test('unlinkDir removes all entries under the directory', (assert) => {
    const fsTree = {
      '/project/test/foo.js': null,
      '/project/test/bar.js': null,
      '/project/other/baz.js': null,
    };
    mutateFSTree(fsTree, 'unlinkDir', '/project/test');
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
    mutateFSTree(fsTree, 'unlinkDir', '/project/test');
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

module('Setup | handleWatchEvent', { concurrency: true }, () => {
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

  test('event while _building is active queues a pending trigger instead of calling onEventFunc', (assert) => {
    const config = {
      fsTree: { '/project/test/foo.js': null },
      projectRoot: '/project',
      _building: true,
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
      _building: true,
      _justAddedFiles: new Set(['/project/test/new.ts']),
    };
    assert.equal(trackCalls(config, 'change', '/project/test/new.ts').length, 0);
    assert.notOk(config._pendingBuildTrigger, 'no pending trigger queued');
  });

  test('second add while building tracks the file so its spurious change is filtered', (assert) => {
    // Two files added rapidly: the second goes through the pending-trigger path. It must also
    // be in _justAddedFiles so its post-add change does not overwrite the pending trigger.
    const config = {
      fsTree: { '/project/test/first.ts': null },
      projectRoot: '/project',
      _building: true,
      _justAddedFiles: new Set(['/project/test/first.ts']),
    };

    trackCalls(config, 'add', '/project/test/second.ts');
    assert.ok(config._justAddedFiles?.has('/project/test/second.ts'), 'tracked in _justAddedFiles');
    assert.ok(config._pendingBuildTrigger, 'pending trigger set');

    const pendingTrigger = config._pendingBuildTrigger;
    trackCalls(config, 'change', '/project/test/second.ts');
    assert.equal(config._pendingBuildTrigger, pendingTrigger, 'pending trigger not overwritten');
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

  test('_lastBuildEndMs is set after an async build completes', async (assert) => {
    const config = { fsTree: { '/project/test/foo.js': null }, projectRoot: '/project' };
    const done = handleWatchEvent(
      config as Config,
      ['js', 'ts'],
      'change',
      '/project/test/foo.js',
      () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
      null,
    );
    assert.notOk(config._lastBuildEndMs, 'not set while in progress');
    assert.equal(config._building, true);
    await done;
    assert.equal(config._building, false);
    assert.ok(config._lastBuildEndMs <= Date.now(), 'set to a valid timestamp');
  });

  test('_lastBuildEndMs is set even when the build throws', async (assert) => {
    const config = { fsTree: { '/project/test/foo.js': null }, projectRoot: '/project' };
    await handleWatchEvent(
      config as Config,
      ['js', 'ts'],
      'change',
      '/project/test/foo.js',
      () => Promise.reject(new Error('simulated failure')),
      null,
    );
    assert.equal(config._building, false);
    assert.ok(config._lastBuildEndMs);
  });

  test('_lastBuildEndMs is NOT set when onEventFunc returns synchronously', async (assert) => {
    const config = { fsTree: { '/project/test/foo.js': null }, projectRoot: '/project' };
    await handleWatchEvent(
      config as Config,
      ['js', 'ts'],
      'change',
      '/project/test/foo.js',
      () => undefined,
      null,
    );
    assert.notOk(config._lastBuildEndMs);
    assert.equal(config._building, false);
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
    await handleWatchEvent(
      config as Config,
      ['js', 'ts'],
      'change',
      '/project/test/foo.js',
      () => Promise.resolve(),
      (p, ev) => calls.push([p, ev]),
    );
    assert.deepEqual(calls, [['/project/test/foo.js', 'change']]);
  });

  test('_lastBuildEndMs advances on each successive build', async (assert) => {
    const config = { fsTree: { '/project/test/foo.js': null }, projectRoot: '/project' };
    const asyncBuild = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

    await handleWatchEvent(
      config as Config,
      ['js', 'ts'],
      'change',
      '/project/test/foo.js',
      asyncBuild,
      null,
    );
    const firstEndMs = config._lastBuildEndMs;
    assert.ok(firstEndMs);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await handleWatchEvent(
      config as Config,
      ['js', 'ts'],
      'change',
      '/project/test/foo.js',
      asyncBuild,
      null,
    );
    assert.ok(config._lastBuildEndMs > firstEndMs);
  });
});

// ---------------------------------------------------------------------------
// setupFileWatchers
// ---------------------------------------------------------------------------

module('Setup | setupFileWatchers', { concurrency: true }, () => {
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

    const { killFileWatchers, ready } = setupFileWatchers(
      [tmpFile], // file path, not a directory — the case that triggered the bug
      config as unknown as Config,
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
});

// ---------------------------------------------------------------------------
// rescanDirectoryForDelta
// ---------------------------------------------------------------------------

module('Setup | rescanDirectoryForDelta', { concurrency: true }, () => {
  test('fires add for a new regular file not yet in fsTree', async (assert) => {
    const dir = path.join(process.cwd(), `tmp/rescan-add-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const newFile = path.join(dir, 'new-test.ts');
    await fs.writeFile(newFile, 'export default {}');

    const config: Partial<Config> & { fsTree: FSTree } = { fsTree: {}, projectRoot: dir };
    const events: Array<{ event: string; file: string }> = [];

    await rescanDirectoryForDelta(
      dir,
      config as Config,
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

    await rescanDirectoryForDelta(
      dir,
      config as Config,
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

    await rescanDirectoryForDelta(
      dir,
      config as Config,
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

    await rescanDirectoryForDelta(
      dir,
      config as Config,
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

    await rescanDirectoryForDelta(
      dir,
      config as Config,
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

    await rescanDirectoryForDelta(
      dir,
      config as Config,
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

    await rescanDirectoryForDelta(
      dir,
      config as Config,
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

  test('silently succeeds when watchPath does not exist', async (assert) => {
    const config: Partial<Config> & { fsTree: FSTree } = { fsTree: {}, projectRoot: '/tmp' };
    const events: Array<{ event: string; file: string }> = [];

    await rescanDirectoryForDelta(
      '/tmp/nonexistent-dir-that-does-not-exist-qunitx',
      config as Config,
      ['ts'],
      (ev, f) => events.push({ event: ev, file: f }),
      null,
    );

    assert.equal(events.length, 0, 'no events fired for missing directory');
  });
});
