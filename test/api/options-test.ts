import { module, test } from 'qunitx';
import * as Options from '../../lib/api/options.ts';
import { InvalidOption, validate } from '../../lib/api/options.ts';
import { APIReporter } from '../../lib/api/reporter.ts';
import { TAPReporter } from '../../lib/reporters/tap.ts';
import { processConsole, silentConsole, streamConsole } from '../../lib/console.ts';
import '../helpers/custom-asserts.ts';

module('API | options | reporting', { concurrency: true }, () => {
  test('silence is the default — no reporter, and an output that discards', (assert) => {
    const { reporters } = Options.from({});

    assert.equal(reporters.length, 1, 'only the collector');
    assert.true(reporters[0] instanceof APIReporter);
    assert.equal(Options.from({}).console, silentConsole);
  });

  test('naming a reporter opts back into the process streams', (assert) => {
    const { reporters } = Options.from({ reporter: 'tap' });

    assert.equal(reporters.length, 2);
    assert.true(reporters[0] instanceof APIReporter, 'collector first');
    assert.true(reporters[1] instanceof TAPReporter);
    assert.equal(Options.from({ reporter: 'tap' }).console, processConsole);
  });

  test('a console of your own is used instead, reporter or not', (assert) => {
    const chunks: string[] = [];
    // Destructured under another name: a local `console` would shadow the global one.
    const { console: runConsole } = Options.from({
      console: streamConsole({ write: (text: string) => void chunks.push(text) }),
    });

    runConsole!.log('hello');
    runConsole!.error('problem');

    assert.deepEqual(chunks, ['hello', 'problem'], 'stderr falls back to the one stream given');
  });

  test('a reporter instance is used as-is, and several stack', (assert) => {
    const mine = { onTestEnd: () => {} };
    const { reporters } = Options.from({ reporters: ['dot', mine] });

    assert.equal(reporters.length, 3);
    assert.equal(reporters[2], mine, 'the object is not copied or wrapped');
  });

  test('`reporter: false` is silence even alongside a stdout', (assert) => {
    const { reporters } = Options.from({ reporter: false });

    assert.equal(reporters.length, 1, 'the collector, and nothing that prints');
  });

  test('a reporter OBJECT does not turn on the process streams', (assert) => {
    // Passing a collector is a request to observe, not to print. Only a named built-in — or an
    // explicit stdout — means "put text on my terminal".
    assert.equal(Options.from({ reporter: { onTestEnd: () => {} } }).console, silentConsole);
  });

  test('a named reporter among objects still opts into them', (assert) => {
    assert.equal(
      Options.from({ reporters: [{ onTestEnd: () => {} }, 'dot'] }).console,
      processConsole,
    );
  });

  test('junit is additive rather than a choice of format', (assert) => {
    const { reporters } = Options.from({ reporter: 'spec', junit: true });

    assert.equal(reporters.length, 3, 'collector + spec + junit');
  });

  test('a console of your own does not by itself add a reporter', (assert) => {
    const { reporters } = Options.from({ console: silentConsole });

    assert.equal(reporters.length, 1, 'the collector, and nothing that prints');
  });
});

module('API | options | translation', { concurrency: true }, () => {
  test('an unset option carries no value', (assert) => {
    // Load-bearing: `Config.setup` spreads these over `package.json#qunitx`, so a key present
    // with an undefined value would erase the project's own setting.
    const config = Options.from({});

    // Absent as a value, not necessarily as a key: `Config.setup` is what strips undefined
    // before the merge, and `test/setup/config-test.ts` is where that promise is asserted.
    assert.equal(config.browser, undefined, 'browser');
    assert.equal(config.coverage, undefined, 'coverage');
    assert.equal(config.portExplicit, undefined, 'portExplicit');
  });

  test('coverage formats come out of the nested shape', (assert) => {
    const config = Options.from({ coverage: { formats: ['lcov'] } });

    assert.true(config.coverage);
    assert.deepEqual(config.coverageFormats, ['lcov']);
  });

  test('bare `coverage: true` asks for the terminal summary only', (assert) => {
    const config = Options.from({ coverage: true });

    assert.true(config.coverage);
    assert.deepEqual(config.coverageFormats, undefined, 'no artifact formats');
  });

  test('an explicit port is marked explicit, so a busy port fails rather than sliding', (assert) => {
    assert.true(Options.from({ port: 4321 }).portExplicit);
    assert.equal(Options.from({}).portExplicit, undefined);
  });

  test('`html` maps onto the internal htmlPaths', (assert) => {
    assert.deepEqual(Options.from({ html: ['test/index.html'] }).htmlPaths, ['test/index.html']);
  });
});

module('API | options | validation', { concurrency: true }, () => {
  // `validate` throws the Failure by identity — the two-tier rule at the option boundary — so a
  // bare try/catch is what a caller sees, and `Result.try` would box it in a `Caught` instead.
  const failureOf = (fn: () => void): unknown => {
    try {
      fn();
      return null;
    } catch (error) {
      return error;
    }
  };

  test('an unknown browser names what it would have accepted', (assert) => {
    const failure = failureOf(() => validate({ browser: 'netscape' as 'chromium' }));

    assert.true(InvalidOption.is(failure));
    assert.includes(InvalidOption.is(failure) ? failure.message : '', 'chromium, firefox, webkit');
  });

  test('an unknown reporter name is rejected; an object is not', (assert) => {
    assert.true(InvalidOption.is(failureOf(() => validate({ reporter: 'json' as 'tap' }))));
    assert.false(InvalidOption.is(failureOf(() => validate({ reporter: { onTestEnd() {} } }))));
  });

  test('an out-of-range port is rejected before anything binds', (assert) => {
    assert.true(InvalidOption.is(failureOf(() => validate({ port: 99999 }))));
    assert.true(InvalidOption.is(failureOf(() => validate({ port: 1.5 }))));
    assert.false(InvalidOption.is(failureOf(() => validate({ port: 0 }))), '0 means "pick one"');
  });

  test('a non-positive timeout is rejected', (assert) => {
    assert.true(InvalidOption.is(failureOf(() => validate({ timeout: 0 }))));
    assert.true(InvalidOption.is(failureOf(() => validate({ timeout: -1 }))));
    assert.false(InvalidOption.is(failureOf(() => validate({ timeout: 1 }))));
  });

  test('`reporter` and `reporters` together is refused, and the message says which to use', (assert) => {
    const failure = failureOf(() => validate({ reporter: 'tap', reporters: ['dot'] }));

    assert.true(InvalidOption.is(failure));
    assert.includes(
      InvalidOption.is(failure) ? failure.message : '',
      '`reporter` for one reporter or `reporters` for several',
    );
  });

  test('either one on its own is fine', (assert) => {
    assert.equal(
      failureOf(() => validate({ reporter: 'tap' })),
      null,
      'one',
    );
    assert.equal(
      failureOf(() => validate({ reporters: ['tap', 'dot'] })),
      null,
      'several',
    );
  });

  test('an unknown coverage format is rejected', (assert) => {
    const failure = failureOf(() => validate({ coverage: { formats: ['pdf' as 'lcov'] } }));

    assert.true(InvalidOption.is(failure));
    assert.includes(InvalidOption.is(failure) ? failure.message : '', 'coverage.formats');
  });

  test('the options a real caller passes are accepted', (assert) => {
    const failure = failureOf(() =>
      validate({
        inputs: ['test/'],
        browser: 'firefox',
        reporters: ['tap', 'github'],
        coverage: { formats: ['lcov', 'html'] },
        port: 8080,
        timeout: 5000,
      }),
    );

    assert.false(InvalidOption.is(failure), 'no false positives on a full option set');
  });
});

module('API | options | call shapes', { concurrency: true }, () => {
  // `run(file, options)` took a target and options from the start; the suite verbs took only one
  // argument, so the obvious `test('test/', { filter })` did not compile. Three shapes each now,
  // and the positional target is the more specific statement of the two.
  test('a target and options merge, with the target winning', (assert) => {
    const merged = Options.toUserOptions('test/', { filter: 'Cart', inputs: ['ignored/'] });

    assert.deepEqual(merged.inputs, ['test/'], 'the positional target beats inputs in the options');
    assert.strictEqual(merged.filter, 'Cart', 'and everything else in the options survives');
  });

  test('an array target merges the same way', (assert) => {
    const merged = Options.toUserOptions(['a-test.ts', 'b-test.ts'], { failFast: true });

    assert.deepEqual(merged.inputs, ['a-test.ts', 'b-test.ts']);
    assert.true(merged.failFast);
  });

  test('the single-object form is returned untouched', (assert) => {
    const original = { inputs: ['test/'], filter: 'Cart' };

    assert.strictEqual(
      Options.toUserOptions(original),
      original,
      'no copy, so nothing can silently diverge from what the caller passed',
    );
  });
});
