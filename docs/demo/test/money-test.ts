import { module, test } from 'qunitx';
import { formatPrice } from '../src/money.ts';

module('Money', () => {
  test('formats dollars', (assert) => {
    assert.equal(formatPrice(15), '$15.00');
  });

  test('formats euros', (assert) => {
    assert.equal(formatPrice(1234.5, 'EUR'), '€1,234.50');
  });
});
