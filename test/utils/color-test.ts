import { module, test } from 'qunitx';
import { createColors } from '../../lib/utils/color.ts';

const on = createColors(true);
const off = createColors(false);

module('Utils | color | enabled', () => {
  test('red wraps text with ANSI red codes', (assert) => {
    assert.equal(on.red('hello'), '\x1b[31mhello\x1b[39m');
  });

  test('green wraps text with ANSI green codes', (assert) => {
    assert.equal(on.green('hello'), '\x1b[32mhello\x1b[39m');
  });

  test('yellow wraps text with ANSI yellow codes', (assert) => {
    assert.equal(on.yellow('hello'), '\x1b[33mhello\x1b[39m');
  });

  test('blue wraps text with ANSI blue codes', (assert) => {
    assert.equal(on.blue('hello'), '\x1b[34mhello\x1b[39m');
  });

  test('magenta(text) wraps text with ANSI magenta codes', (assert) => {
    assert.equal(on.magenta('hello'), '\x1b[35mhello\x1b[39m');
  });

  test('magenta().bold(text) wraps text with magenta + bold codes', (assert) => {
    assert.equal(on.magenta().bold('hello'), '\x1b[35m\x1b[1mhello\x1b[22m\x1b[39m');
  });

  test('colors handle empty string', (assert) => {
    assert.equal(on.red(''), '\x1b[31m\x1b[39m');
  });

  test('colors handle numeric coercion via String()', (assert) => {
    assert.equal(on.blue('42'), '\x1b[34m42\x1b[39m');
  });
});

module('Utils | color | disabled', () => {
  test('red returns plain text', (assert) => {
    assert.equal(off.red('hello'), 'hello');
  });

  test('green returns plain text', (assert) => {
    assert.equal(off.green('hello'), 'hello');
  });

  test('yellow returns plain text', (assert) => {
    assert.equal(off.yellow('hello'), 'hello');
  });

  test('blue returns plain text', (assert) => {
    assert.equal(off.blue('hello'), 'hello');
  });

  test('magenta(text) returns plain text', (assert) => {
    assert.equal(off.magenta('hello'), 'hello');
  });

  test('magenta().bold(text) returns plain text', (assert) => {
    assert.equal(off.magenta().bold('hello'), 'hello');
  });

  test('non-string values are coerced to string', (assert) => {
    assert.equal(off.red(42), '42');
    assert.equal(off.green(true), 'true');
  });
});
