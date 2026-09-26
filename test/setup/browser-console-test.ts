import { module, test } from 'qunitx';
import { showsWithoutDebug } from '../../lib/setup/browser.ts';

module('Setup | browser | showsWithoutDebug', { concurrency: true }, () => {
  test('errors and warnings print without --debug, other levels do not', (assert) => {
    assert.true(showsWithoutDebug('error', 'boom'));
    assert.true(showsWithoutDebug('warning', 'deprecated option'));
    assert.false(showsWithoutDebug('log', 'hello'));
    assert.false(showsWithoutDebug('info', 'hello'));
  });

  test("Firefox's own parser diagnostics wait for --debug", (assert) => {
    const diagnostic =
      '[JavaScript Warning: "unreachable code after return statement" {file: "http://localhost:1234/tests.js" line: 2551}]';

    assert.false(showsWithoutDebug('warning', diagnostic));
    assert.true(showsWithoutDebug('error', diagnostic), 'an error is never hidden');
  });
});
