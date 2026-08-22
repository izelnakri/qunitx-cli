import { test } from 'qunitx';

// Preload fixture for the REPL tests: exports that must become globals in the page, a function
// whose stack must map back to THIS file, and a test that must run as the session opens.

export const GREETING = 'hello from the preload';

export function double(value: number): number {
  return value * 2;
}

export function boom(): never {
  throw new Error('fixture boom');
}

test('preloaded test', (assert) => {
  assert.equal(double(21), 42);
});
