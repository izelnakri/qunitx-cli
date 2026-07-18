import { module, test } from 'qunitx';
import { double } from './coverage/calculator.ts';

// A realistic multi-import header with a blank line below, so line targets can be exercised
// against non-declaration lines (imports/comments/blanks → "run the whole file"). The tests that
// use this fixture look declarations up BY NAME, not by hard-coded line number, so you can add
// imports or blank lines here for manual testing without breaking them.

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
    assert.equal(double(2), 4);
  });
});
