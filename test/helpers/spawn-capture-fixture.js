#!/usr/bin/env node
// Multi-mode fixture for test/helpers/shell-test.ts. Avoids `node -e` so the test commands
// have no whitespace inside any single arg (the shell helper's splitter is intentionally
// naive — qunitx CLI invocations never need quoting, and adding a real parser just to
// test the helper would invert the dependency).
const mode = process.argv[2];

if (mode === 'success') {
  process.stdout.write('hello');
  process.stderr.write('warn');
} else if (mode === 'fail') {
  process.stdout.write('partial');
  process.exit(7);
} else if (mode === 'sleep') {
  setTimeout(() => {}, 5_000);
} else if (mode === 'two-chunks') {
  process.stdout.write('a');
  // Use unref so the timer doesn't extend the process beyond the second write.
  setTimeout(() => process.stdout.write('b'), 50);
} else if (mode === 'echo-env') {
  // Echo a known env var so the test can assert it was forwarded by the env-prefix parser.
  process.stdout.write(`MY_TEST_VAR=${process.env.MY_TEST_VAR ?? 'unset'}`);
} else {
  process.stderr.write(`unknown mode: ${mode}`);
  process.exit(2);
}
