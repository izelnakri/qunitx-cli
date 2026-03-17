import { module, test } from 'qunitx';
import parseCliFlags from '../../lib/utils/parse-cli-flags.js';

const PROJECT_ROOT = '/some/project';

function withArgv(args, fn) {
  const original = process.argv;
  process.argv = ['node', 'cli.js', ...args];
  try {
    return fn();
  } finally {
    process.argv = original;
  }
}

module('Setup | parseCliFlags | --timeout', () => {
  test('--timeout value is parsed as a number, not a string', (assert) => {
    const flags = withArgv(['--timeout=5000'], () => parseCliFlags(PROJECT_ROOT));
    assert.strictEqual(typeof flags.timeout, 'number', 'timeout must be a number');
    assert.strictEqual(flags.timeout, 5000);
  });

  test('--timeout arithmetic does not produce string concatenation', (assert) => {
    const flags = withArgv(['--timeout=5000'], () => parseCliFlags(PROJECT_ROOT));
    // This is how tests-in-browser.js uses config.timeout: config.timeout + 10000
    // If timeout is the string "5000", this produces "500010000" instead of 15000.
    assert.strictEqual(
      flags.timeout + 10000,
      15000,
      'timeout + 10000 must equal 15000, not "500010000"',
    );
  });

  test('--timeout defaults to 10000 when not provided', (assert) => {
    const flags = withArgv([], () => parseCliFlags(PROJECT_ROOT));
    assert.strictEqual(flags.timeout, undefined, 'timeout is undefined when flag is not passed');
  });
});
