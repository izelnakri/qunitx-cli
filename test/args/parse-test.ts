import { module, test } from 'qunitx';
import path from 'node:path';
import * as Args from '../../lib/args/index.ts';
import * as Result from '../../lib/result/index.ts';

const PROJECT_ROOT = '/some/project';

module('Args | parse | inputs', { concurrency: true }, () => {
  test('relative input is resolved against cwd', (assert) => {
    const flags = parseFlags(['tests/foo.ts']);
    assert.deepEqual(flags.inputs, [path.join(process.cwd(), 'tests/foo.ts')]);
  });

  test('absolute input inside project root is kept absolute (separator-normalized)', (assert) => {
    const flags = parseFlags([`${PROJECT_ROOT}/tests/foo.ts`]);
    assert.deepEqual(flags.inputs, [path.normalize(`${PROJECT_ROOT}/tests/foo.ts`)]);
  });

  test('absolute input outside project root is kept absolute (not prefixed with cwd)', (assert) => {
    const flags = parseFlags(['/tmp/demo.ts']);
    assert.deepEqual(flags.inputs, [path.normalize('/tmp/demo.ts')]);
  });

  test('Windows absolute input (drive-letter prefix) is kept as-is, not joined onto cwd', (assert) => {
    // Regression test: Args.parse previously detected absolute paths via
    // `arg.startsWith('/')`, which missed Windows drive-letter paths. A path like
    // 'D:\\some\\fixture.ts' would silently get joined onto process.cwd(),
    // yielding 'D:\\<cwd>\\D:\\some\\fixture.ts' — a path that always ENOENTs.
    // The check is now path.isAbsolute(), which handles both POSIX and Windows.
    const winPath = 'D:\\some\\fixture.ts';
    const flags = parseFlags([winPath]);
    // path.isAbsolute on POSIX returns false for 'D:\\…', so this test only
    // exercises the new behaviour on Windows hosts. On POSIX the input is
    // (correctly) treated as relative, so we accept either outcome.
    if (path.isAbsolute(winPath)) {
      assert.deepEqual(flags.inputs, [winPath]);
    } else {
      assert.ok(true, 'POSIX host: path.isAbsolute returns false for drive-letter paths');
    }
  });
});

module('Args | parse | --extensions', { concurrency: true }, () => {
  test('parses a single extension', (assert) => {
    const flags = parseFlags(['--extensions=mjs']);
    assert.deepEqual(flags.extensions, ['mjs']);
  });

  test('parses multiple comma-separated extensions', (assert) => {
    const flags = parseFlags(['--extensions=js,ts,mjs']);
    assert.deepEqual(flags.extensions, ['js', 'ts', 'mjs']);
  });

  test('trims whitespace around each extension', (assert) => {
    const flags = parseFlags(['--extensions=js, ts , mjs']);
    assert.deepEqual(flags.extensions, ['js', 'ts', 'mjs']);
  });

  test('is undefined when the flag is not provided', (assert) => {
    const flags = parseFlags([]);
    assert.strictEqual(flags.extensions, undefined);
  });
});

module('Args | parse | --port', { concurrency: true }, () => {
  test('--port parses as a number and sets portExplicit', (assert) => {
    const flags = parseFlags(['--port=5678']);
    assert.strictEqual(flags.port, 5678);
    assert.strictEqual(flags.portExplicit, true);
  });

  test('-p=<n> is the short alias for --port', (assert) => {
    const flags = parseFlags(['-p=5678']);
    assert.strictEqual(flags.port, 5678);
    assert.strictEqual(flags.portExplicit, true);
  });

  test('--port is undefined when not provided — 1234 comes from default-project-config-values', (assert) => {
    const flags = parseFlags([]);
    assert.strictEqual(flags.port, undefined, 'Args.parse yields no port when flag is absent');
    assert.strictEqual(flags.portExplicit, undefined);
  });
});

module('Args | parse | --watch', { concurrency: true }, () => {
  test('--watch sets watch to true', (assert) => {
    const flags = parseFlags(['--watch']);
    assert.strictEqual(flags.watch, true);
  });

  test('-w shorthand sets watch to true', (assert) => {
    const flags = parseFlags(['-w']);
    assert.strictEqual(flags.watch, true);
  });

  test('-w=false sets watch to false', (assert) => {
    const flags = parseFlags(['-w=false']);
    assert.strictEqual(flags.watch, false);
  });

  test('watch is undefined when neither flag is passed', (assert) => {
    const flags = parseFlags([]);
    assert.strictEqual(flags.watch, undefined);
  });

  test('-w is not swallowed as an input path', (assert) => {
    const flags = parseFlags(['-w', 'test/foo.ts']);
    assert.strictEqual(flags.watch, true);
    assert.deepEqual(flags.inputs, [path.join(process.cwd(), 'test/foo.ts')]);
  });
});

module('Args | parse | --open', { concurrency: true }, () => {
  test('--open with no value sets open to true', (assert) => {
    const flags = parseFlags(['--open']);
    assert.strictEqual(flags.open, true);
  });

  test('-o shorthand sets open to true', (assert) => {
    const flags = parseFlags(['-o']);
    assert.strictEqual(flags.open, true);
  });

  test('--open=false sets open to false', (assert) => {
    const flags = parseFlags(['--open=false']);
    assert.strictEqual(flags.open, false);
  });

  test('--open=brave sets open to the string "brave"', (assert) => {
    const flags = parseFlags(['--open=brave']);
    assert.strictEqual(flags.open, 'brave');
  });
});

module('Args | parse | --failFast', { concurrency: true }, () => {
  test('--failFast sets failFast to true', (assert) => {
    const flags = parseFlags(['--failFast']);
    assert.strictEqual(flags.failFast, true);
  });

  test('--failfast alias also sets failFast to true', (assert) => {
    const flags = parseFlags(['--failfast']);
    assert.strictEqual(flags.failFast, true);
  });
});

module('Args | parse | --only-failed', { concurrency: true }, () => {
  test('--only-failed sets onlyFailed to true', (assert) => {
    const flags = parseFlags(['--only-failed']);
    assert.strictEqual(flags.onlyFailed, true);
  });

  test('-f shorthand sets onlyFailed to true', (assert) => {
    const flags = parseFlags(['-f']);
    assert.strictEqual(flags.onlyFailed, true);
  });

  test('--failed alias sets onlyFailed to true', (assert) => {
    const flags = parseFlags(['--failed']);
    assert.strictEqual(flags.onlyFailed, true);
  });

  test('--only-failed=false sets onlyFailed to false', (assert) => {
    const flags = parseFlags(['--only-failed=false']);
    assert.strictEqual(flags.onlyFailed, false);
  });

  test('onlyFailed is undefined when the flag is not provided', (assert) => {
    const flags = parseFlags([]);
    assert.strictEqual(flags.onlyFailed, undefined);
  });

  test('--failed does not collide with --failFast', (assert) => {
    const flags = parseFlags(['--failFast']);
    assert.strictEqual(flags.onlyFailed, undefined, '--failFast must not set onlyFailed');
    assert.strictEqual(flags.failFast, true);
  });
});

module('Args | parse | --changed / --since', { concurrency: true }, () => {
  test('--changed sets changedSince to "HEAD"', (assert) => {
    const flags = parseFlags(['--changed']);
    assert.strictEqual(flags.changedSince, 'HEAD');
  });

  test('--since=<ref> sets changedSince to the given ref', (assert) => {
    const flags = parseFlags(['--since=main']);
    assert.strictEqual(flags.changedSince, 'main');
  });

  test('--since=origin/main keeps the slash-bearing ref', (assert) => {
    const flags = parseFlags(['--since=origin/main']);
    assert.strictEqual(flags.changedSince, 'origin/main');
  });

  test('changedSince is undefined when neither flag is present', (assert) => {
    const flags = parseFlags([]);
    assert.strictEqual(flags.changedSince, undefined);
  });
});

module('Args | parse | --timeout', { concurrency: true }, () => {
  test('parses its value as a number, not a string', (assert) => {
    const flags = parseFlags(['--timeout=5000']);
    assert.strictEqual(typeof flags.timeout, 'number', 'timeout must be a number');
    assert.strictEqual(flags.timeout, 5000);
  });

  test('arithmetic on the value adds, never concatenates', (assert) => {
    const flags = parseFlags(['--timeout=5000']);
    // This is how tests-in-browser.js uses config.timeout: config.timeout + 10000
    // If timeout is the string "5000", this produces "500010000" instead of 15000.
    assert.strictEqual(
      flags.timeout + 10000,
      15000,
      'timeout + 10000 must equal 15000, not "500010000"',
    );
  });

  test('defaults to 10000 when not provided', (assert) => {
    const flags = parseFlags([]);
    assert.strictEqual(flags.timeout, undefined, 'timeout is undefined when flag is not passed');
  });
});

module('Args | parse | -t / --filter', { concurrency: true }, () => {
  test('--filter=<pattern> sets filter', (assert) => {
    const flags = parseFlags(['--filter=adds']);
    assert.strictEqual(flags.filter, 'adds');
  });

  test('-t=<pattern> sets filter', (assert) => {
    const flags = parseFlags(['-t=adds']);
    assert.strictEqual(flags.filter, 'adds');
  });

  test('-t <pattern> (space separated) sets filter', (assert) => {
    const flags = parseFlags(['-t', 'adds']);
    assert.strictEqual(flags.filter, 'adds');
    assert.deepEqual(flags.inputs, [], 'the value must not be captured as an input path');
  });

  test('--filter <pattern> (space separated) sets filter', (assert) => {
    const flags = parseFlags(['--filter', 'adds']);
    assert.strictEqual(flags.filter, 'adds');
  });

  test('a space-separated value is consumed even when it looks like a flag', (assert) => {
    const flags = parseFlags(['-t', '!slow']);
    assert.strictEqual(flags.filter, '!slow', 'an inverted filter must not warn as unknown flag');
  });

  test('a regex filter keeps everything after the first "="', (assert) => {
    const flags = parseFlags(['--filter=/a=b/i']);
    assert.strictEqual(flags.filter, '/a=b/i');
  });

  test('a trailing -t with no value is ignored, not applied to a path', (assert) => {
    const flags = parseFlags(['tests/foo.ts', '-t']);
    assert.strictEqual(flags.filter, undefined);
    assert.deepEqual(flags.inputs, [path.join(process.cwd(), 'tests/foo.ts')]);
  });

  test('filter is undefined when the flag is not provided', (assert) => {
    const flags = parseFlags([]);
    assert.strictEqual(flags.filter, undefined);
  });

  test('--filter does not collide with --failfast, --failed or --timeout', (assert) => {
    const flags = parseFlags(['--failFast', '--failed', '--timeout=5000']);
    assert.strictEqual(flags.filter, undefined, 'no neighbouring flag may set filter');
    assert.strictEqual(flags.failFast, true);
    assert.strictEqual(flags.onlyFailed, true);
    assert.strictEqual(flags.timeout, 5000);
  });

  test('--filter is not swallowed by the --failed prefix check', (assert) => {
    const flags = parseFlags(['--filter=x']);
    assert.strictEqual(flags.filter, 'x');
    assert.strictEqual(flags.onlyFailed, undefined);
    assert.strictEqual(flags.failFast, undefined);
  });
});

module('Args | parse | -m / --module are spellings of the filter', { concurrency: true }, () => {
  test('all four spellings set the same field', (assert) => {
    const values = ['-t=Math', '--filter=Math', '-m=Math', '--module=Math'].map(
      (arg) => parseFlags([arg]).filter,
    );
    assert.deepEqual(values, ['Math', 'Math', 'Math', 'Math']);
  });

  test('there is no separate module field to set', (assert) => {
    const flags = parseFlags(['-m=Math']);
    assert.notOk('module' in flags, 'QUnit.config.module is deliberately unused');
  });

  test('-m <name> (space separated) sets filter', (assert) => {
    const flags = parseFlags(['-m', 'Math']);
    assert.strictEqual(flags.filter, 'Math');
    assert.deepEqual(flags.inputs, []);
  });

  test('a nested module path keeps its " > " separator', (assert) => {
    const flags = parseFlags(['-m', 'Parent > Child']);
    assert.strictEqual(flags.filter, 'Parent > Child');
  });

  test('filter is undefined when no spelling is provided', (assert) => {
    const flags = parseFlags([]);
    assert.strictEqual(flags.filter, undefined);
  });

  test('giving two spellings is last-wins, and says so rather than dropping one silently', (assert) => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    try {
      const flags = parseFlags(['-m', 'Math', '-t', 'adds']);
      assert.strictEqual(flags.filter, 'adds', 'the last expression wins');
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes('"adds"') && warnings[0].includes('"Math"'), warnings[0]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('repeating the same expression does not warn', (assert) => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    try {
      parseFlags(['-m', 'Math', '-t', 'Math']);
      assert.deepEqual(warnings, []);
    } finally {
      console.warn = originalWarn;
    }
  });
});

module('Args | parse | --search / --print', { concurrency: true }, () => {
  test('all search spellings set search', (assert) => {
    const values = ['-s=Cart', '--search=Cart', '--print=Cart', '--preview=Cart'].map(
      (arg) => parseFlags([arg]).search,
    );
    assert.deepEqual(values, ['Cart', 'Cart', 'Cart', 'Cart']);
  });

  test('a bare --print sets search to true (list everything)', (assert) => {
    const flags = parseFlags(['--print']);
    assert.strictEqual(flags.search, true);
  });

  test('search is undefined when not provided', (assert) => {
    const flags = parseFlags([]);
    assert.strictEqual(flags.search, undefined);
  });

  test('search and filter are independent fields', (assert) => {
    const flags = parseFlags(['-t', 'Cart', '-s', 'Coupons']);
    assert.strictEqual(flags.filter, 'Cart');
    assert.strictEqual(flags.search, 'Coupons');
  });

  test('a bare -s leaves filter to supply the expression', (assert) => {
    const flags = parseFlags(['-t', 'Cart', '-s']);
    assert.strictEqual(flags.filter, 'Cart');
    assert.strictEqual(flags.search, true);
  });
});

module('Args | parse | greedy query values', { concurrency: true }, () => {
  test('a bare -m joins following words into a multi-word value', (assert) => {
    const flags = parseFlags(['-m', 'Some', 'Module', 'loading', 'tests']);
    assert.strictEqual(flags.filter, 'Some Module loading tests');
    assert.deepEqual(flags.inputs, [], 'no word leaks out as an input');
  });

  test('greedy consumption stops at the next flag, leaving trailing flags intact', (assert) => {
    const flags = parseFlags(['-t', 'Some Module loading tests', '--junit', '--reporter=spec']);
    // (Shell would split the quoted value into one token; unquoted multiword is covered above.)
    assert.strictEqual(flags.filter, 'Some Module loading tests');
    assert.strictEqual(flags.junit, true);
    assert.strictEqual(flags.reporter, 'spec');
  });

  test('inputs placed before a query flag stay inputs', (assert) => {
    const flags = parseFlags(['test/a', 'test/b', '-m', 'Cart', 'checkout']);
    assert.strictEqual(flags.filter, 'Cart checkout');
    assert.deepEqual(flags.inputs, [
      path.join(process.cwd(), 'test/a'),
      path.join(process.cwd(), 'test/b'),
    ]);
  });

  test('inputs after a bare query flag are swallowed into the value (the ordering cost)', (assert) => {
    const flags = parseFlags(['-t', 'login', 'flow', 'test/auth']);
    assert.strictEqual(flags.filter, 'login flow test/auth');
    assert.deepEqual(flags.inputs, []);
  });

  test('-- ends option parsing so targets can follow a filter', (assert) => {
    const flags = parseFlags(['-t', 'login flow', '--', 'test/auth']);
    assert.strictEqual(flags.filter, 'login flow');
    assert.deepEqual(flags.inputs, [path.join(process.cwd(), 'test/auth')]);
  });

  test('a glued --filter= value is taken as-is, never greedy', (assert) => {
    const flags = parseFlags(['--filter=adds', 'test/foo.ts']);
    assert.strictEqual(flags.filter, 'adds');
    assert.deepEqual(flags.inputs, [path.join(process.cwd(), 'test/foo.ts')]);
  });
});

module('Args | parse | swallowed-target hint', { concurrency: true }, () => {
  let warnings: string[] = [];
  const originalWarn = console.warn;

  function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
    warnings = [];
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    try {
      return { result: fn(), warnings };
    } finally {
      console.warn = originalWarn;
    }
  }

  test('warns when a greedy value contains a file-looking word', (assert) => {
    const { warnings: warned } = captureWarnings(() =>
      parseFlags(['-t', 'login', 'flow', 'test/auth.ts']),
    );
    assert.equal(warned.length, 1, 'exactly one hint');
    assert.ok(warned[0].includes('"test/auth.ts"'), 'names the swallowed target');
    assert.ok(warned[0].includes('--filter/-t'), 'names the flag');
  });

  test('does not warn for an ordinary multi-word filter', (assert) => {
    const { warnings: warned } = captureWarnings(() => parseFlags(['-t', 'renders the header']));
    assert.deepEqual(warned, []);
  });

  test('does not warn for a regex filter that merely mentions an extension', (assert) => {
    const { warnings: warned } = captureWarnings(() => parseFlags(['-t', '/render.tsx?/']));
    assert.deepEqual(warned, [], 'a trailing slash is not a file extension');
  });

  test('does not warn for an explicit --filter= value', (assert) => {
    const { warnings: warned } = captureWarnings(() => parseFlags(['--filter=test/auth.ts']));
    assert.deepEqual(warned, [], 'a quoted/glued value is taken as intended');
  });
});

module('Args | parse | line targets', { concurrency: true }, () => {
  test('#34 is stripped off the input and recorded as a line target', (assert) => {
    const flags = parseFlags(['tests/foo.ts#34']);
    const absolute = path.join(process.cwd(), 'tests/foo.ts');
    assert.deepEqual(flags.inputs, [absolute], 'the bare path is what gets discovered');
    assert.deepEqual(flags.lineTargets, { [absolute]: [34] });
  });

  test(':34 is accepted as an alias for #34', (assert) => {
    const flags = parseFlags(['tests/foo.ts:34']);
    const absolute = path.join(process.cwd(), 'tests/foo.ts');
    assert.deepEqual(flags.inputs, [absolute]);
    assert.deepEqual(flags.lineTargets, { [absolute]: [34] });
  });

  test('several line targets on one file accumulate and the path dedupes', (assert) => {
    const flags = parseFlags(['tests/foo.ts#3', 'tests/foo.ts#9']);
    const absolute = path.join(process.cwd(), 'tests/foo.ts');
    assert.deepEqual(flags.inputs, [absolute], 'inputs is a Set — one entry for the file');
    assert.deepEqual(flags.lineTargets, { [absolute]: [3, 9] });
  });

  test('line targets across different files are kept apart', (assert) => {
    const flags = parseFlags(['a.ts#3', 'b.ts#9']);
    assert.deepEqual(flags.lineTargets, {
      [path.join(process.cwd(), 'a.ts')]: [3],
      [path.join(process.cwd(), 'b.ts')]: [9],
    });
  });

  test('a line target on an absolute path is recorded against that path', (assert) => {
    const flags = parseFlags([`${PROJECT_ROOT}/tests/foo.ts#7`]);
    const expected = path.normalize(`${PROJECT_ROOT}/tests/foo.ts`);
    assert.deepEqual(flags.inputs, [expected]);
    assert.deepEqual(flags.lineTargets, { [expected]: [7] });
  });

  test('a plain input has no line targets', (assert) => {
    const flags = parseFlags(['tests/foo.ts']);
    assert.strictEqual(flags.lineTargets, undefined);
  });

  test('mixing a line-targeted input with a plain one keeps both inputs', (assert) => {
    const flags = parseFlags(['a.ts#34', 'b.ts']);
    assert.deepEqual(flags.inputs, [
      path.join(process.cwd(), 'a.ts'),
      path.join(process.cwd(), 'b.ts'),
    ]);
    assert.deepEqual(flags.lineTargets, { [path.join(process.cwd(), 'a.ts')]: [34] });
  });

  test('#0 is not a line target — lines are 1-based', (assert) => {
    const flags = parseFlags(['tests/foo.ts#0']);
    assert.deepEqual(flags.inputs, [path.join(process.cwd(), 'tests/foo.ts#0')]);
    assert.strictEqual(flags.lineTargets, undefined);
  });

  test('a non-numeric suffix is left on the path', (assert) => {
    const flags = parseFlags(['tests/foo.ts#abc']);
    assert.deepEqual(flags.inputs, [path.join(process.cwd(), 'tests/foo.ts#abc')]);
    assert.strictEqual(flags.lineTargets, undefined);
  });

  test('a path that genuinely contains "#" is left alone', (assert) => {
    const flags = parseFlags(['tests/foo#bar.ts']);
    assert.deepEqual(flags.inputs, [path.join(process.cwd(), 'tests/foo#bar.ts')]);
    assert.strictEqual(flags.lineTargets, undefined);
  });

  test('a bare separator with no path is not a line target', (assert) => {
    const flags = parseFlags([':34']);
    assert.deepEqual(flags.inputs, [path.join(process.cwd(), ':34')]);
    assert.strictEqual(flags.lineTargets, undefined);
  });

  // These two assert only the line-target split, not absoluteness: path.isAbsolute('D:\…')
  // is false on POSIX hosts, so the resolved input differs by platform.
  test('a Windows drive-letter colon is not mistaken for a line target', (assert) => {
    const flags = parseFlags(['D:\\some\\fixture.ts']);
    assert.strictEqual(flags.lineTargets, undefined);
    assert.ok(flags.inputs[0].endsWith('D:\\some\\fixture.ts'), 'path is untouched');
  });

  test('a Windows path keeps its line target', (assert) => {
    const flags = parseFlags(['D:\\some\\fixture.ts:12']);
    const [input] = flags.inputs;
    assert.ok(input.endsWith('D:\\some\\fixture.ts'), 'the ":12" suffix is stripped off the path');
    assert.deepEqual(flags.lineTargets, { [input]: [12] });
  });
});

module('Args | parse | -r / --console aliases', { concurrency: true }, () => {
  test('-r=<name> sets reporter like --reporter', (assert) => {
    assert.strictEqual(parseFlags(['-r=dot']).reporter, 'dot');
    assert.strictEqual(parseFlags(['--reporter=dot']).reporter, 'dot');
  });

  test('--console sets debug like --debug', (assert) => {
    assert.strictEqual(parseFlags(['--console']).debug, true);
    assert.strictEqual(parseFlags(['--console=false']).debug, false);
  });
});

module('Args | parse | --reporter validation', { concurrency: true }, () => {
  test('accepts each of the four reporter names', (assert) => {
    for (const name of ['tap', 'spec', 'dot', 'github']) {
      assert.strictEqual(parseFlags([`--reporter=${name}`]).reporter, name);
    }
  });

  test('an unknown value exits 1, naming both the value and the valid set', (assert) => {
    const failure = parseFailure(['--reporter=nope']);

    assert.strictEqual(failure.code, 'InvalidFlag');
    assert.strictEqual(failure.data.flag, '--reporter');
    assert.strictEqual(failure.data.value, 'nope');
    assert.strictEqual(
      failure.message,
      'Invalid --reporter value: "nope". Must be one of: tap, spec, dot, github',
    );
  });

  test('a bare --reporter is rejected rather than silently defaulting to tap', (assert) => {
    const failure = parseFailure(['--reporter']);

    assert.strictEqual(failure.code, 'InvalidFlag');
    assert.strictEqual(failure.data.value, '');
  });
});

function withArgv(args, fn) {
  const original = process.argv;
  process.argv = ['node', 'cli.ts', ...args];
  try {
    return fn();
  } finally {
    process.argv = original;
  }
}

/**
 * Parses `args` and returns the flags, throwing if the parse was rejected.
 *
 * `Args.parse` returns `Result<ParsedFlags, InvalidFlag>`, so the happy path unwraps. A
 * rejection here surfaces as a normal test failure naming the flag — where it previously
 * called `process.exit(1)` and took the whole test worker with it.
 */
function parseFlags(args) {
  return Result.unwrap(withArgv(args, () => Args.parse(PROJECT_ROOT)));
}

/**
 * Parses `args` expecting rejection, and returns the failure.
 *
 * This replaces a `withExitCaptured` helper that monkeypatched `process.exit` into throwing a
 * `Symbol` and swapped out `console.error` to read the message back — the only way to observe
 * a validation branch when the function under test reported by exiting. The failure is now an
 * ordinary return value, so the whole apparatus is gone.
 */
function parseFailure(args) {
  const result = withArgv(args, () => Args.parse(PROJECT_ROOT));
  if (result.ok) throw new Error(`expected \`${args.join(' ')}\` to be rejected, but it parsed`);
  return result.error;
}
