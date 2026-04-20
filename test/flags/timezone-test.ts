import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import shell from '../helpers/shell.ts';

// Cross-platform: verify Chrome inherits whatever timezone the OS has configured.
// On Linux this uses glibc; on macOS CoreFoundation; on Windows the registry.
// The assertion compares the browser's Intl timezone against the Node.js process
// timezone — both read from the same OS source, so they must agree on all platforms.
module('browser timezone: OS system timezone', { concurrency: true }, (_hooks, moduleMetadata) => {
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

// Linux-only: verify that the TZ env var overrides are reflected in the browser.
// Chrome on macOS uses CoreFoundation and on Windows uses the registry — both ignore TZ.
if (process.platform === 'linux') {
  module(
    'browser timezone: TZ env var override (Linux)',
    { concurrency: true },
    (_hooks, moduleMetadata) => {
      test('TZ=UTC is reflected in browser Intl.DateTimeFormat', async (assert, testMetadata) => {
        const result = await shell('TZ=UTC node cli.ts test/fixtures/timezone-tests.ts --debug', {
          ...moduleMetadata,
          ...testMetadata,
        });

        assert.includes(result, 'BROWSER_TZ:UTC');
        assert.tapResult(result, { testCount: 1 });
      });

      test('TZ=America/Los_Angeles is reflected in browser Intl.DateTimeFormat', async (assert, testMetadata) => {
        const result = await shell(
          'TZ=America/Los_Angeles node cli.ts test/fixtures/timezone-tests.ts --debug',
          { ...moduleMetadata, ...testMetadata },
        );

        assert.includes(result, 'BROWSER_TZ:America/Los_Angeles');
        assert.tapResult(result, { testCount: 1 });
      });

      test('TZ=Europe/Berlin is reflected in browser Intl.DateTimeFormat', async (assert, testMetadata) => {
        const result = await shell(
          'TZ=Europe/Berlin node cli.ts test/fixtures/timezone-tests.ts --debug',
          { ...moduleMetadata, ...testMetadata },
        );

        assert.includes(result, 'BROWSER_TZ:Europe/Berlin');
        assert.tapResult(result, { testCount: 1 });
      });
    },
  );
}
