import { module, test } from 'qunitx';

module('Cart', () => {
  test('calculates subtotal', (assert) => {
    const items = [{ price: 10 }, { price: 20 }, { price: 5 }];
    const total = items.reduce((sum, item) => sum + item.price, 0);
    assert.equal(total, 35, 'subtotal is correct');
  });

  test('applies 10% discount', (assert) => {
    assert.equal(Math.round(100 * 0.9), 90);
  });

  test('validates stock level', (assert) => {
    const stock = 0;
    assert.ok(stock > 0, 'expected items in stock'); // ← will fail
  });

  test('calculates tax', (assert) => {
    assert.equal(100 * 0.2, 20); // ← never reached with --failFast
  });
});
