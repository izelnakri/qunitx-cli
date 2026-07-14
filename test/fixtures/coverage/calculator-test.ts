import { module, test } from 'qunitx';
import { add, double, abs } from './calculator.ts';

module('Calculator', (_hooks) => {
  test('add and double are exercised', (assert) => {
    assert.equal(add(2, 3), 5);
    assert.equal(double(4), 8);
    assert.equal(abs(5), 5); // only the non-negative branch of abs runs
  });
});
