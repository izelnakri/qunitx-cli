import { module, test } from 'qunitx';

// Line numbers in this file are asserted by test/flags/filter-test.ts and
// test/flags/line-target-test.ts. Adding or removing lines above a declaration
// will break them — update both if you edit this file.

module('Outer', function () {
  test('outer first', function (assert) {
    assert.ok(true);
  });

  test('outer second', function (assert) {
    assert.ok(true);
  });

  module('Inner', function () {
    test('inner only', function (assert) {
      assert.ok(true);
    });
  });
});

module('Separate', function () {
  test('separate one', function (assert) {
    assert.ok(true);
  });
});
