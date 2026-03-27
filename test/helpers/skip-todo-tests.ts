import { module, test } from 'qunitx';

module('{{moduleName}} Skip and Todo Tests', function () {
  test('passing test runs normally', function (assert) {
    assert.ok(true);
  });

  test.skip('skipped test is not executed', function (assert) {
    assert.ok(false, 'skipped tests should not run');
  });

  // A todo test is expected to fail; if it passes unexpectedly it becomes a real failure.
  test.todo('todo test is expected to fail', function (assert) {
    assert.ok(false, 'this todo test is supposed to fail');
  });
});
