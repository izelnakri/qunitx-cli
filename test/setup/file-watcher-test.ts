import { module, test } from 'qunitx';
import { mutateFSTree, handleWatchEvent } from '../../lib/setup/file-watcher.ts';

module('Setup | mutateFSTree', { concurrency: true }, () => {
  test('add event inserts path into fsTree', (assert) => {
    const fsTree = {};
    mutateFSTree(fsTree, 'add', '/project/test/foo.js');
    assert.deepEqual(fsTree, { '/project/test/foo.js': null });
  });

  test('unlink event removes path from fsTree', (assert) => {
    const fsTree = { '/project/test/foo.js': null };
    mutateFSTree(fsTree, 'unlink', '/project/test/foo.js');
    assert.deepEqual(fsTree, {});
  });

  test('unlinkDir removes all entries under the deleted directory', (assert) => {
    const fsTree = {
      '/project/test/foo.js': null,
      '/project/test/bar.js': null,
      '/project/other/baz.js': null,
    };
    mutateFSTree(fsTree, 'unlinkDir', '/project/test');
    assert.deepEqual(fsTree, { '/project/other/baz.js': null });
  });
});

module('Setup | handleWatchEvent', { concurrency: true }, () => {
  test('js file change triggers onEventFunc and updates fsTree', (assert) => {
    const fsTree = { '/project/test/foo.js': null };
    const config = { fsTree, projectRoot: '/project' };
    const calls = [];

    handleWatchEvent(config, ['js', 'ts'], 'change', '/project/test/foo.js', (event, path) => {
      calls.push({ event, path });
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].event, 'change');
    assert.equal(calls[0].path, '/project/test/foo.js');
  });

  test('ts file add updates fsTree and triggers onEventFunc', (assert) => {
    const fsTree = {};
    const config = { fsTree, projectRoot: '/project' };
    const calls = [];

    handleWatchEvent(config, ['js', 'ts'], 'add', '/project/test/new.ts', (event, path) => {
      calls.push({ event, path });
    });

    assert.deepEqual(config.fsTree, { '/project/test/new.ts': null });
    assert.equal(calls.length, 1);
  });

  test('unlink removes file from fsTree and triggers onEventFunc', (assert) => {
    const fsTree = { '/project/test/gone.js': null };
    const config = { fsTree, projectRoot: '/project' };
    const calls = [];

    handleWatchEvent(config, ['js', 'ts'], 'unlink', '/project/test/gone.js', (event, path) => {
      calls.push({ event, path });
    });

    assert.deepEqual(config.fsTree, {});
    assert.equal(calls.length, 1);
  });

  test('unlinkDir bypasses extension filter and removes all files under the directory from fsTree', (assert) => {
    const fsTree = {
      '/project/test/unit/foo.js': null,
      '/project/test/unit/bar.ts': null,
      '/project/test/integration/baz.js': null,
    };
    const config = { fsTree, projectRoot: '/project' };
    const calls = [];

    handleWatchEvent(config, ['js', 'ts'], 'unlinkDir', '/project/test/unit', (event, path) => {
      calls.push({ event, path });
    });

    assert.deepEqual(config.fsTree, { '/project/test/integration/baz.js': null });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].event, 'unlinkDir');
    assert.equal(calls[0].path, '/project/test/unit');
  });

  test('unlinkDir with no matching files is a no-op on fsTree but still calls onEventFunc', (assert) => {
    const fsTree = { '/project/other/baz.js': null };
    const config = { fsTree, projectRoot: '/project' };
    const calls = [];

    handleWatchEvent(config, ['js', 'ts'], 'unlinkDir', '/project/test', (event, path) => {
      calls.push({ event, path });
    });

    assert.deepEqual(config.fsTree, { '/project/other/baz.js': null });
    assert.equal(calls.length, 1);
  });

  test('non-matching file extension (e.g. .css) is ignored entirely', (assert) => {
    const fsTree = {};
    const config = { fsTree, projectRoot: '/project' };
    const calls = [];

    handleWatchEvent(config, ['js', 'ts'], 'change', '/project/styles/app.css', (event, path) => {
      calls.push({ event, path });
    });

    assert.deepEqual(config.fsTree, {});
    assert.equal(calls.length, 0);
  });

  test('debounce: second event while _building is active does not trigger onEventFunc', (assert) => {
    const fsTree = { '/project/test/foo.js': null };
    const config = { fsTree, projectRoot: '/project', _building: true };
    const calls = [];

    handleWatchEvent(config, ['js', 'ts'], 'change', '/project/test/foo.js', (event, path) => {
      calls.push({ event, path });
    });

    assert.equal(calls.length, 0);
  });

  test('spurious change for just-added file is ignored while building (no pending trigger queued)', (assert) => {
    // Simulates the post-add inotify flush: rename (→ add) fires first, then change fires
    // after the file content is written to disk. The add's filtered run is still in progress
    // (_building = true), so the change must not queue a full re-run as a pending trigger.
    const fsTree = { '/project/test/new.ts': null };
    const config = {
      fsTree,
      projectRoot: '/project',
      _building: true,
      _justAddedFiles: new Set(['/project/test/new.ts']),
    };
    const calls = [];

    handleWatchEvent(config, ['js', 'ts'], 'change', '/project/test/new.ts', (event, path) => {
      calls.push({ event, path });
    });

    assert.equal(calls.length, 0, 'onEventFunc not called for spurious change');
    assert.notOk(config._pendingBuildTrigger, 'no pending trigger queued for spurious change');
  });

  test('second add while building adds to _justAddedFiles so its spurious change is also filtered', (assert) => {
    // When two files are added in rapid succession, the second add goes through the pending
    // trigger path. Its file must also be tracked in _justAddedFiles so the spurious post-add
    // change for it does not overwrite the pending add trigger with a full re-run.
    const fsTree = { '/project/test/first.ts': null };
    const config = {
      fsTree,
      projectRoot: '/project',
      _building: true,
      _justAddedFiles: new Set(['/project/test/first.ts']),
    };
    const calls = [];

    // Second add queues a pending trigger and should add the file to _justAddedFiles.
    handleWatchEvent(config, ['js', 'ts'], 'add', '/project/test/second.ts', (event, path) => {
      calls.push({ event, path });
    });

    assert.ok(
      config._justAddedFiles?.has('/project/test/second.ts'),
      'second file tracked in _justAddedFiles',
    );
    assert.ok(config._pendingBuildTrigger, 'pending trigger set for the second add');

    // Spurious change for second file must be filtered (no overwrite of pending trigger).
    const pendingBeforeChange = config._pendingBuildTrigger;
    handleWatchEvent(config, ['js', 'ts'], 'change', '/project/test/second.ts', (event, path) => {
      calls.push({ event, path });
    });

    assert.equal(
      config._pendingBuildTrigger,
      pendingBeforeChange,
      'pending trigger not overwritten by spurious change',
    );
    assert.equal(calls.length, 0, 'onEventFunc not called');
  });

  test('custom extensions: .mjs file triggers onEventFunc when extensions includes mjs', (assert) => {
    const fsTree = {};
    const config = { fsTree, projectRoot: '/project' };
    const calls = [];

    handleWatchEvent(config, ['mjs'], 'add', '/project/test/new.mjs', (event, path) => {
      calls.push({ event, path });
    });

    assert.deepEqual(config.fsTree, { '/project/test/new.mjs': null });
    assert.equal(calls.length, 1);
  });

  test('custom extensions: .js file is ignored when extensions only includes mjs', (assert) => {
    const fsTree = {};
    const config = { fsTree, projectRoot: '/project' };
    const calls = [];

    handleWatchEvent(config, ['mjs'], 'add', '/project/test/new.js', (event, path) => {
      calls.push({ event, path });
    });

    assert.deepEqual(config.fsTree, {});
    assert.equal(calls.length, 0);
  });
});
