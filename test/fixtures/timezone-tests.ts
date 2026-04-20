import { module, test } from 'qunitx';

module('Timezone Tests', function () {
  test('browser reports Intl timezone', function (assert) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    console.log(`BROWSER_TZ:${tz}`);
    assert.ok(tz.length > 0);
  });
});
