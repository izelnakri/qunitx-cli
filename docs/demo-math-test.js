import { module, test } from 'qunitx';

module('Math', (hooks) => {
  hooks.beforeEach(function () {
    this.numbers = [1, 2, 3];
  });

  test('equal and notEqual', (assert) => {
    assert.equal(1 + 1, 2, 'addition');
    assert.notEqual(1 + 1, 3);
  });

  test('strictEqual', (assert) => {
    assert.strictEqual('hello', 'hello');
    assert.notStrictEqual(1, '1', '1 !== "1" (type-strict)');
  });

  test('deepEqual — user profile sync', (assert) => {
    const response = { user: { name: 'Alice', scores: [95, 88, 92] }, active: true };
    const expected = { user: { name: 'Alice', scores: [95, 88, 92] }, active: true };
    assert.deepEqual(response, expected, 'API response matches expected shape');
  });

  test('hooks: beforeEach resets state per test', function (assert) {
    assert.deepEqual(this.numbers, [1, 2, 3]);
    this.numbers.push(4);
    assert.equal(this.numbers.length, 4);
  });

  module('Async', () => {
    test('async/await', async (assert) => {
      const data = await Promise.resolve({ id: 1, name: 'Alice' });
      console.log(data.name, 'resolved in Chrome');
      assert.propContains(data, { name: 'Alice' });
    });

    test('assert.rejects', async (assert) => {
      await assert.rejects(Promise.reject(new TypeError('invalid')), TypeError);
    });
  });
});

module('Assertions', () => {
  test('throws — match by constructor', (assert) => {
    assert.throws(() => { throw new RangeError('out of bounds'); }, RangeError);
  });

  test('step/verifySteps — execution order', (assert) => {
    assert.step('init');
    assert.step('process');
    assert.step('done');
    assert.verifySteps(['init', 'process', 'done']);
  });

  test('propContains — partial object match', (assert) => {
    const user = { id: 1, name: 'Alice', role: 'admin', active: true };
    assert.propContains(user, { role: 'admin', active: true });
  });
});
