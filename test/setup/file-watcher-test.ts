import { module, test } from 'qunitx';
import { mutateFSTree, handleWatchEvent } from '../../lib/setup/file-watcher.ts';

module('Setup | mutateFSTree', () => {
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

module('Setup | handleWatchEvent', () => {
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
