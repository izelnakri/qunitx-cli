import { module, test } from 'qunitx';
import { matchesQUnitFilter, qunitFullName } from '../../lib/selection/qunit-filter-match.ts';

// The exact fullNames QUnit builds for test/fixtures + the overlapping-name cart fixture. Every
// expectation below was verified against a real browser run before being encoded here, so this
// file pins the port to observed QUnit behaviour rather than to a reading of its source.
const CART = qunitFullName('Cart', 'adds item');
const COUPONS = qunitFullName('Cart > Coupons', 'applies code');
const SHOPPING = qunitFullName('ShoppingCart', 'renders');
const ITEM = qunitFullName('CartItem', 'renders');
const CHECKOUT = qunitFullName('Cart checkout', 'pays');
const ALL = [CART, COUPONS, SHOPPING, ITEM, CHECKOUT];

const matched = (filter: string | undefined) => ALL.filter((n) => matchesQUnitFilter(filter, n));

module('Utils | qunitFullName', { concurrency: true }, () => {
  test('joins module and test with ": "', (assert) => {
    assert.equal(qunitFullName('Cart', 'adds item'), 'Cart: adds item');
  });

  test('a nested module keeps its " > " path', (assert) => {
    assert.equal(qunitFullName('Cart > Coupons', 'applies code'), 'Cart > Coupons: applies code');
  });

  test('a top-level test yields a leading ": " — QUnit\'s own shape, not a quirk', (assert) => {
    assert.equal(qunitFullName('', 'loose'), ': loose');
    assert.true(matchesQUnitFilter('loose', qunitFullName('', 'loose')));
  });
});

module('Utils | matchesQUnitFilter | substring', { concurrency: true }, () => {
  test('an absent or empty filter matches everything', (assert) => {
    assert.deepEqual(matched(undefined), ALL);
    assert.deepEqual(matched(''), ALL);
  });

  test('substring matching is always case-insensitive', (assert) => {
    // Verified against a real run: `-t cart` -> 5 matches.
    assert.deepEqual(matched('cart'), ALL);
    assert.deepEqual(matched('CART'), ALL);
  });

  test('a substring matches the module path, not just the test name', (assert) => {
    assert.deepEqual(matched('Coupons'), [COUPONS], 'finds a nested module by its own name');
  });

  test('a substring spanning module and test name matches', (assert) => {
    assert.deepEqual(matched('Cart check'), [CHECKOUT]);
  });

  test('a leading ! inverts, and the module path counts toward the exclusion', (assert) => {
    assert.deepEqual(matched('!Cart'), [], 'every fullName here contains "cart"');
    assert.deepEqual(matched('!Coupons'), [CART, SHOPPING, ITEM, CHECKOUT]);
  });

  test('a filter matching nothing yields nothing', (assert) => {
    assert.deepEqual(matched('nothing-matches-this'), []);
  });
});

module('Utils | matchesQUnitFilter | regex', { concurrency: true }, () => {
  test('a regex is case-SENSITIVE without the i flag', (assert) => {
    // The surprising one, verified against a real run: `-t /cart/` -> 0, `-t cart` -> 5.
    assert.deepEqual(matched('/cart/'), []);
  });

  test('the i flag makes it case-insensitive', (assert) => {
    assert.deepEqual(matched('/cart/i'), ALL);
  });

  test('^ anchors to the start, excluding ShoppingCart only', (assert) => {
    assert.deepEqual(matched('/^Cart/'), [CART, COUPONS, ITEM, CHECKOUT]);
  });

  test('the exact-module recipe selects a module and its descendants only', (assert) => {
    // `-t '/^Cart(:| >)/'` is the documented stand-in for an exact module match.
    assert.deepEqual(matched('/^Cart(:| >)/'), [CART, COUPONS]);
  });

  test('a module-only match excludes its nested descendants', (assert) => {
    assert.deepEqual(matched('/^Cart: /'), [CART]);
  });

  test('!/regex/ inverts', (assert) => {
    assert.deepEqual(matched('!/^Cart(:| >)/'), [SHOPPING, ITEM, CHECKOUT]);
  });

  test('a regex keeping its own = is not truncated', (assert) => {
    assert.true(matchesQUnitFilter('/a=b/i', 'A=B: x'));
  });

  test('a bare / is a substring, not a regex', (assert) => {
    assert.deepEqual(matched('/'), [], 'no fullName here contains a literal /');
    assert.true(matchesQUnitFilter('/', 'a/b: x'));
  });
});
