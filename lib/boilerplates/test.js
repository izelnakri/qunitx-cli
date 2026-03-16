import { module, test } from 'qunitx';

module('{{moduleName}}', function (_hooks) {
  test('assert true works', function (assert) {
    assert.expect(3);
    assert.ok(true);
    assert.equal(true, true);
    assert.deepEqual({}, {});
  });

  test('async test finishes', async function (assert) {
    assert.expect(3);

    const wait = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(true), 50);
      });
    const result = await wait();

    assert.ok(true);
    assert.equal(true, result);

    await wait();
    assert.equal(true, result);
  });
});
