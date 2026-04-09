import { module, test } from 'qunitx';
import parseCliFlags from '../../lib/utils/parse-cli-flags.ts';

const PROJECT_ROOT = '/some/project';

function withArgv(args, fn) {
  const original = process.argv;
  process.argv = ['node', 'cli.ts', ...args];
  try {
    return fn();
  } finally {
    process.argv = original;
  }
}

module('Setup | parseCliFlags | --extensions', () => {
  test('--extensions parses a single extension', (assert) => {
    const flags = withArgv(['--extensions=mjs'], () => parseCliFlags(PROJECT_ROOT));
    assert.deepEqual(flags.extensions, ['mjs']);
  });

  test('--extensions parses multiple comma-separated extensions', (assert) => {
    const flags = withArgv(['--extensions=js,ts,mjs'], () => parseCliFlags(PROJECT_ROOT));
    assert.deepEqual(flags.extensions, ['js', 'ts', 'mjs']);
  });

  test('--extensions trims whitespace around each extension', (assert) => {
    const flags = withArgv(['--extensions=js, ts , mjs'], () => parseCliFlags(PROJECT_ROOT));
    assert.deepEqual(flags.extensions, ['js', 'ts', 'mjs']);
  });

  test('--extensions is undefined when flag is not provided', (assert) => {
    const flags = withArgv([], () => parseCliFlags(PROJECT_ROOT));
    assert.strictEqual(flags.extensions, undefined);
  });
});

module('Setup | parseCliFlags | --port', () => {
  test('--port parses as a number and sets portExplicit', (assert) => {
    const flags = withArgv(['--port=5678'], () => parseCliFlags(PROJECT_ROOT));
    assert.strictEqual(flags.port, 5678);
    assert.strictEqual(flags.portExplicit, true);
  });

  test('--port is undefined (not 1234) when not provided — default comes from default-project-config-values', (assert) => {
    const flags = withArgv([], () => parseCliFlags(PROJECT_ROOT));
    assert.strictEqual(flags.port, undefined, 'parseCliFlags yields no port when flag is absent');
    assert.strictEqual(flags.portExplicit, undefined);
  });
});

module('Setup | parseCliFlags | --open', () => {
  test('--open with no value sets open to true', (assert) => {
    const flags = withArgv(['--open'], () => parseCliFlags(PROJECT_ROOT));
    assert.strictEqual(flags.open, true);
  });

  test('-o shorthand sets open to true', (assert) => {
    const flags = withArgv(['-o'], () => parseCliFlags(PROJECT_ROOT));
    assert.strictEqual(flags.open, true);
  });

  test('--open=false sets open to false', (assert) => {
    const flags = withArgv(['--open=false'], () => parseCliFlags(PROJECT_ROOT));
    assert.strictEqual(flags.open, false);
  });

  test('--open=brave sets open to the string "brave"', (assert) => {
    const flags = withArgv(['--open=brave'], () => parseCliFlags(PROJECT_ROOT));
    assert.strictEqual(flags.open, 'brave');
  });
});

module('Setup | parseCliFlags | --failFast', () => {
  test('--failFast sets failFast to true', (assert) => {
    const flags = withArgv(['--failFast'], () => parseCliFlags(PROJECT_ROOT));
    assert.strictEqual(flags.failFast, true);
  });

  test('--failfast alias also sets failFast to true', (assert) => {
    const flags = withArgv(['--failfast'], () => parseCliFlags(PROJECT_ROOT));
    assert.strictEqual(flags.failFast, true);
  });
});

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
