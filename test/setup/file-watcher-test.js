import { module, test } from 'qunitx';
import { mutateFSTree } from '../../lib/setup/file-watcher.js';

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
