import { module, test } from 'qunitx';
import {
  InvalidOption,
  normalizeOptions,
  resolveReporting,
  toConfigOptions,
  validate,
} from '../../lib/api/options.ts';
import { Collector } from '../../lib/api/result.ts';
import { TAPReporter } from '../../lib/reporters/tap.ts';
import { processOutput, silentOutput } from '../../lib/reporters/output.ts';
import '../helpers/custom-asserts.ts';

module('API | options | shorthands', { concurrency: true }, () => {
  test('a bare string is one input', (assert) => {
    assert.deepEqual(normalizeOptions('test/cart-test.ts').inputs, ['test/cart-test.ts']);
  });

  test('a bare array is the input list', (assert) => {
    assert.deepEqual(normalizeOptions(['a.ts', 'b.ts']).inputs, ['a.ts', 'b.ts']);
  });

  test('an options object passes through untouched', (assert) => {
    const options = { filter: 'Cart', coverage: true };
    assert.equal(normalizeOptions(options), options, 'the same object, not a copy');
  });

  test('no argument at all is an empty run request', (assert) => {
    assert.deepEqual(normalizeOptions(), {});
  });
});

module('API | options | reporting', { concurrency: true }, () => {
  test('silence is the default — no reporter, and an output that discards', (assert) => {
    const reporting = resolveReporting({});

    assert.equal(reporting.reporters.length, 1, 'only the collector');
    assert.true(reporting.reporters[0] instanceof Collector);
    assert.equal(reporting.output, silentOutput);
  });

  test('naming a reporter opts back into the process streams', (assert) => {
    const reporting = resolveReporting({ reporter: 'tap' });

    assert.equal(reporting.reporters.length, 2);
    assert.true(reporting.reporters[0] instanceof Collector, 'collector first');
    assert.true(reporting.reporters[1] instanceof TAPReporter);
    assert.equal(reporting.output, processOutput);
  });

  test('a stdout of your own is used instead, reporter or not', (assert) => {
    const chunks: string[] = [];
    const reporting = resolveReporting({ stdout: { write: (text) => void chunks.push(text) } });

    reporting.output.write('hello');
    reporting.output.error('problem');

    assert.deepEqual(chunks, ['hello', 'problem'], 'stderr falls back to the one stream given');
  });

  test('a reporter instance is used as-is, and several stack', (assert) => {
    const mine = { onTestEnd: () => {} };
    const reporting = resolveReporting({ reporter: ['dot', mine] });

    assert.equal(reporting.reporters.length, 3);
    assert.equal(reporting.reporters[2], mine, 'the object is not copied or wrapped');
  });

  test('`reporter: false` is silence even alongside a stdout', (assert) => {
    const reporting = resolveReporting({ reporter: false });

    assert.equal(reporting.reporters.length, 1, 'the collector, and nothing that prints');
  });

  test('a reporter OBJECT does not turn on the process streams', (assert) => {
    // Passing a collector is a request to observe, not to print. Only a named built-in — or an
    // explicit stdout — means "put text on my terminal".
    const reporting = resolveReporting({ reporter: { onTestEnd: () => {} } });

    assert.equal(reporting.output, silentOutput);
  });

  test('a named reporter among objects still opts into them', (assert) => {
    const reporting = resolveReporting({ reporter: [{ onTestEnd: () => {} }, 'dot'] });

    assert.equal(reporting.output, processOutput);
  });

  test('junit is additive rather than a choice of format', (assert) => {
    const reporting = resolveReporting({ reporter: 'spec', junit: true });

    assert.equal(reporting.reporters.length, 3, 'collector + spec + junit');
  });

  test('the callbacks become one reporter', (assert) => {
    const reporting = resolveReporting({ onTest: () => {}, onNotice: () => {} });

    assert.equal(reporting.reporters.length, 2, 'collector + the callback adapter');
  });
});

module('API | options | config translation', { concurrency: true }, () => {
  const reporting = () => resolveReporting({});

  test('an unset option is absent, not undefined', (assert) => {
    // Load-bearing: `Config.setup` spreads these over `package.json#qunitx`, so a key present
    // with an undefined value would erase the project's own setting.
    const config = toConfigOptions({}, reporting());

    assert.false('browser' in config, 'browser');
    assert.false('coverage' in config, 'coverage');
    assert.false('portExplicit' in config, 'portExplicit');
  });

  test('coverage formats come out of the nested shape', (assert) => {
    const config = toConfigOptions({ coverage: { formats: ['lcov'] } }, reporting());

    assert.true(config.coverage);
    assert.deepEqual(config.coverageFormats, ['lcov']);
  });

  test('bare `coverage: true` asks for the terminal summary only', (assert) => {
    const config = toConfigOptions({ coverage: true }, reporting());

    assert.true(config.coverage);
    assert.deepEqual(config.coverageFormats, undefined, 'no artifact formats');
  });

  test('an explicit port is marked explicit, so a busy port fails rather than sliding', (assert) => {
    assert.true(toConfigOptions({ port: 4321 }, reporting()).portExplicit);
    assert.false('portExplicit' in toConfigOptions({}, reporting()));
  });

  test('`html` maps onto the internal htmlPaths', (assert) => {
    assert.deepEqual(toConfigOptions({ html: ['test/index.html'] }, reporting()).htmlPaths, [
      'test/index.html',
    ]);
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
        reporter: ['tap', 'github'],
        coverage: { formats: ['lcov', 'html'] },
        port: 8080,
        timeout: 5000,
      }),
    );

    assert.false(InvalidOption.is(failure), 'no false positives on a full option set');
  });
});
