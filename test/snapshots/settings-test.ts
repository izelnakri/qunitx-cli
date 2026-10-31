import { module, test } from 'qunitx';
import * as Args from '../../lib/args/index.ts';
import * as Options from '../../lib/api/options.ts';
import * as RunState from '../../lib/setup/run-state.ts';
import { checkSettings, fileNameOf } from '../../lib/snapshots/index.ts';

const parse = (argv: string[]) => Args.parse('/some/project', argv, '/some/project');

module('Snapshots | settings', { concurrency: true }, () => {
  test('every setting by record’s rules; undefined is not a value', (assert) => {
    assert.deepEqual(checkSettings(undefined), {});
    assert.deepEqual(
      checkSettings({
        dir: 'visual',
        update: true,
        threshold: 0.2,
        maxDiff: 40,
        mask: ['#clock'],
        report: true,
        prComment: true,
        imagesUrl: 'https://example.com/s/',
        reportUrl: 'https://example.com/run',
        maxDiffs: undefined,
      }),
      {
        dir: 'visual',
        update: true,
        threshold: 0.2,
        maxDiff: 40,
        mask: ['#clock'],
        report: true,
        prComment: true,
        imagesUrl: 'https://example.com/s/',
        reportUrl: 'https://example.com/run',
      },
    );
  });

  test('a bad setting is refused by name and reason', (assert) => {
    const message = (raw: unknown) => (checkSettings(raw) as Error).message;

    assert.deepEqual(
      [
        message('visual'),
        message({ colour: 'red' }),
        message({ threshold: 2 }),
        message({ maxDiff: 1.5 }),
        message({ mask: '#clock' }),
        message({ update: 'yes' }),
        message({ imagesUrl: 'example.com' }),
        message({ dir: '' }),
      ],
      [
        'snapshots: must be an object',
        'snapshots.colour: is not a snapshot setting (dir, update, threshold, maxDiff, mask, report, prComment, imagesUrl, reportUrl, pdf)',
        'snapshots.threshold: expected a fraction from 0 to 1, got 2',
        'snapshots.maxDiff: expected a whole number from 0 to 9007199254740991, got 1.5',
        'snapshots.mask: expected a list of CSS selectors, got "#clock"',
        'snapshots.update: expected true or false, got "yes"',
        'snapshots.imagesUrl: expected an http(s) URL, got "example.com"',
        'snapshots.dir: expected a path, got ""',
      ],
    );
  });

  test('a name is a path under the snapshot dir: folders by `/`, nothing a file name cannot hold', (assert) => {
    assert.deepEqual(['home', 'cart/empty state', 'Checkout: step 1?', 'a\\b'].map(fileNameOf), [
      'home',
      'cart/empty state',
      'Checkout- step 1-',
      'a-b',
    ]);
    assert.throws(() => fileNameOf(''), /a snapshot needs a name, got ""/);
    assert.throws(() => fileNameOf(42), /a snapshot needs a name, got 42/);
    assert.throws(() => fileNameOf('../out'), /not a usable snapshot name/);
    assert.throws(() => fileNameOf('a//b'), /not a usable snapshot name/);
  });
});

module('Snapshots | flags, API options and run state', { concurrency: true }, () => {
  test('each --snapshot-* flag sets its setting; masks add up; a selector keeps its own `=`', (assert) => {
    const flags = parse([
      '--update-snapshots',
      '--snapshot-dir=visual',
      '--snapshot-threshold=0.25',
      '--snapshot-max-diff=12',
      '--snapshot-mask=#clock',
      '--snapshot-mask=[data-live=yes]',
      '--snapshot-report',
      '--snapshot-pr-comment',
      '--snapshot-images-url=https://example.com/s/',
      '--snapshot-report-url=https://example.com/run',
    ]) as Args.ParsedFlags;

    assert.deepEqual(flags.snapshots, {
      update: true,
      dir: 'visual',
      threshold: 0.25,
      maxDiff: 12,
      mask: ['#clock', '[data-live=yes]'],
      report: true,
      prComment: true,
      imagesUrl: 'https://example.com/s/',
      reportUrl: 'https://example.com/run',
    });
    assert.equal((parse([]) as Args.ParsedFlags).snapshots, undefined, 'none unless asked');
  });

  test('a flag value record would refuse is refused here, saying why', (assert) => {
    const message = (argv: string[]) => (parse(argv) as Error).message;

    assert.equal(
      message(['--snapshot-threshold=2']),
      'Invalid --snapshot-threshold value: "2". Expected a fraction from 0 to 1, got "2".',
    );
    assert.equal(
      message(['--snapshot-max-diff=few']),
      'Invalid --snapshot-max-diff value: "few". Expected a whole number from 0 to 9007199254740991, got "few".',
    );
    assert.equal(
      message(['--snapshot-mask']),
      'Invalid --snapshot-mask value: "". Expected a CSS selector.',
    );
    assert.equal(
      message(['--snapshot-images-url=nope']),
      'Invalid --snapshot-images-url value: "nope". Expected an http(s) URL, got "nope".',
    );
  });

  test('the JS API hands its snapshots option to the run as it is', (assert) => {
    assert.deepEqual(Options.from({ snapshots: { update: true, mask: ['#clock'] } }).snapshots, {
      update: true,
      mask: ['#clock'],
    });
  });

  test('a new run starts with no snapshots, cleared in place', (assert) => {
    const { results } = RunState.create();
    const snapshots = results.snapshots;
    snapshots.open.push('/proj/snapshots/a.gif');
    snapshots.reportPath = '/proj/snapshots/report.html';
    RunState.reset(results, false);

    assert.strictEqual(results.snapshots, snapshots, 'the same object');
    assert.deepEqual(snapshots, {
      taken: [],
      recordings: [],
      open: [],
      reportPath: null,
      reportPdfPath: null,
      commentPath: null,
    });
  });
});
