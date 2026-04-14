import { module, test } from 'qunitx';

module('{{moduleName}} Assert Timeout Sync Tests', function () {
  // Fails: assert.timeout(0) requires synchronous completion; await violates that.
  test('assert.timeout(0) fails async test', async function (assert) {
    assert.timeout(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(true, 'should never reach here');
  });
});
