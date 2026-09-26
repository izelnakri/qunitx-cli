import { module, test } from 'qunitx';
import { Cart } from '../src/cart.ts';

module('Cart', () => {
  test('starts empty', (assert) => {
    assert.equal(new Cart().total, 0);
  });

  test('totals price times quantity', (assert) => {
    const cart = new Cart()
      .add({ name: 'Coffee', price: 4, qty: 3 })
      .add({ name: 'Bagel', price: 3 });

    assert.equal(cart.total, 15);
  });

  test('renders into the real DOM', (assert) => {
    const page = document.querySelector('#qunit-fixture')!;
    page.append(new Cart().add({ name: 'Tea', price: 2, qty: 2 }).render());

    assert.equal(page.querySelector('li')?.textContent, '2 × Tea');
  });
});
