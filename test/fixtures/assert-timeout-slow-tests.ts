import { module, test } from 'qunitx';

module('{{moduleName}} Assert Timeout Slow Tests', function () {
  // Fails: assert.timeout(100) fires before the hanging promise resolves.
  // The test is marked not-ok; the suite continues and exits with code 1.
  test('assert.timeout fails when test exceeds deadline', async function (assert) {
    assert.timeout(100);
    await new Promise(() => {}); // hangs forever
    assert.ok(true, 'should never reach here');
  });
});
