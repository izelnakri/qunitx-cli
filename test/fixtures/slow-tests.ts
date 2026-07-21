import { module, test } from 'qunitx';

module('{{moduleName}} Slow Tests', function () {
  // This test never resolves — used to verify that --timeout kills hanging tests.
  test('this test hangs forever', async function (assert) {
    assert.expect(1);
    await new Promise(() => {});
  });
});
