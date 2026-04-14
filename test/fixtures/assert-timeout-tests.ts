import { module, test } from 'qunitx';

module('{{moduleName}} Assert Timeout Tests', function () {
  // Passes: assert.timeout() set to 500ms, test completes in ~50ms.
  test('assert.timeout passes when test completes before deadline', async function (assert) {
    assert.timeout(500);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(true, 'completed within timeout');
  });

  // Passes: assert.timeout(0) on a synchronous test is fine.
  test('assert.timeout(0) passes for synchronous tests', function (assert) {
    assert.timeout(0);
    assert.ok(true, 'synchronous test passes with timeout(0)');
  });
});
