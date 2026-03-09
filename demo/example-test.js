import { module, test } from 'qunitx';

module('User', () => {
  test('can sign up with a valid email', (assert) => {
    const email = 'alice@example.com';
    assert.ok(email.includes('@'), 'email contains @');
  });

  test('password must be at least 8 characters', (assert) => {
    assert.equal('secret123'.length >= 8, true);
  });
});

module('Shopping cart', () => {
  test('starts empty', (assert) => {
    assert.deepEqual({ items: [] }.items, []);
  });

  test('calculates total correctly', (assert) => {
    const total = [10, 20, 5].reduce((a, b) => a + b, 0);
    assert.equal(total, 35);
  });
});
