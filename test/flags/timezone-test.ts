import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import { execute as shell } from '../helpers/shell.ts';

// Cross-platform: verify Chrome inherits whatever timezone the OS has configured.
// On Linux this uses glibc; on macOS CoreFoundation; on Windows the registry.
// The assertion compares the browser's Intl timezone against the Node.js process
// timezone — both read from the same OS source, so they must agree on all platforms.
module('Flags | --timezone | OS default', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('browser Intl timezone matches the process timezone', async (assert, testMetadata) => {
    const nodeTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const result = await shell('node cli.ts test/fixtures/timezone-tests.ts --debug', {
      ...moduleMetadata,
      ...testMetadata,
    });

    assert.includes(result, `BROWSER_TZ:${nodeTz}`);
    assert.tapResult(result, { testCount: 1 });
  });
});

// Linux-only: verify that a TZ env var override reaches the browser. Chrome on macOS uses
// CoreFoundation and on Windows the registry — both ignore TZ. One named non-UTC zone is
// enough: TZ is inherited by the browser process as a whole, so every zone travels the same
// single mechanism (env inheritance → glibc → Chrome's ICU), and a second zone would only
// re-test glibc's tzdata.
if (process.platform === 'linux') {
  module('Flags | --timezone | TZ override', { concurrency: true }, (_hooks, moduleMetadata) => {
    test('TZ is reflected in the browser Intl.DateTimeFormat timezone', async (assert, testMetadata) => {
      const result = await shell(
        'TZ=America/Los_Angeles node cli.ts test/fixtures/timezone-tests.ts --debug',
        { ...moduleMetadata, ...testMetadata },
      );

      assert.includes(result, 'BROWSER_TZ:America/Los_Angeles');
      assert.tapResult(result, { testCount: 1 });
    });
  });
}
