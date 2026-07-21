import { module, test } from 'qunitx';
import * as Coverage from '../../lib/coverage/index.ts';
import * as RunState from '../../lib/setup/run-state.ts';
import type { SourceMapDecoder } from '../../lib/utils/source-map.ts';
import type { Config, CoverageFileMap } from '../../lib/types.ts';

// A hand-built two-line bundle whose source map attributes each generated line to a distinct
// original line, so we can assert the V8-range → original-line attribution deterministically
// without launching a browser.
//   bundle: "foo();\nbar();\n"   (offsets: line0 = 0..5, '\n' at 6; line1 = 7..12, '\n' at 13)
const BUNDLE_SOURCE = 'foo();\nbar();\n';

function makeDecoder(): SourceMapDecoder {
  return {
    segmentsByLine: [
      [{ generatedCol: 0, sourceIndex: 0, sourceLine: 0, sourceCol: 0 }], // bundle line0 → src line1
      [{ generatedCol: 0, sourceIndex: 0, sourceLine: 1, sourceCol: 0 }], // bundle line1 → src line2
    ],
    sources: ['src/x.ts'],
    sourceRoot: '',
    outDir: '/proj/tmp',
    sourcesContent: ['foo();\nbar();\n'],
  };
}

function makeConfig(decoder: SourceMapDecoder, collector: CoverageFileMap): Config {
  return {
    projectRoot: '/proj/tmp',
    output: 'tmp',
    state: {
      ...RunState.create(),
      results: { ...RunState.create().results, coverage: collector },
      group: { ...RunState.create().group, sourceMapDecoder: decoder },
    },
  } as unknown as Config;
}

// One outer function range covering the whole bundle with count 1, plus a nested range over
// bundle line1 with count 0 → line1 covered, line2 coverable-but-missed (the V8 nesting rule).
const V8_ENTRIES = [
  {
    url: 'http://localhost:1234/tests.js',
    scriptId: '1',
    source: BUNDLE_SOURCE,
    functions: [
      {
        functionName: '',
        isBlockCoverage: true,
        ranges: [
          { startOffset: 0, endOffset: 13, count: 1 },
          { startOffset: 7, endOffset: 13, count: 0 },
        ],
      },
    ],
  },
];

module('Coverage | collect + report', { concurrency: true }, () => {
  test('attributes covered and missed original lines from V8 ranges', async (assert) => {
    const collector: CoverageFileMap = new Map();
    await Coverage.collect(makeConfig(makeDecoder(), collector), V8_ENTRIES);

    const fileCoverage = collector.get('/proj/tmp/src/x.ts');
    assert.ok(fileCoverage, 'source file recorded by absolute path');
    assert.deepEqual([...fileCoverage!.coverable].sort(), [1, 2], 'both lines are coverable');
    assert.equal(fileCoverage!.covered.get(1), 1, 'line 1 covered (count 1)');
    assert.equal(fileCoverage!.covered.get(2), undefined, 'line 2 not covered (count 0)');
  });

  test('reads the bundle from disk only when the entry has no source', async (assert) => {
    // Empty source + a non-existent output dir → readBundleSource returns null → nothing recorded.
    const collector: CoverageFileMap = new Map();
    const entries = [{ ...V8_ENTRIES[0], source: '' }];
    await Coverage.collect(makeConfig(makeDecoder(), collector), entries);
    assert.equal(collector.size, 0, 'no attribution when source is unavailable');
  });

  test('skips non-bundle script URLs', async (assert) => {
    const collector: CoverageFileMap = new Map();
    const entries = [{ ...V8_ENTRIES[0], url: 'http://localhost:1234/app.js' }];
    await Coverage.collect(makeConfig(makeDecoder(), collector), entries);
    assert.equal(collector.size, 0, 'only /tests.js (or /filtered-tests.js) is attributed');
  });

  test('buildRows computes percentages and excludes test entry files', (assert) => {
    const collector: CoverageFileMap = new Map([
      [
        '/proj/tmp/src/x.ts',
        { coverable: new Set([1, 2]), covered: new Map([[1, 1]]), sourceContent: null },
      ],
      [
        '/proj/tmp/test/x-test.ts',
        { coverable: new Set([1]), covered: new Map([[1, 1]]), sourceContent: null },
      ],
    ]);
    const rows = Coverage.Report.buildRows(
      collector,
      new Set(['/proj/tmp/test/x-test.ts']),
      '/proj/tmp',
    );
    assert.equal(rows.length, 1, 'test entry file excluded');
    assert.equal(rows[0].displayPath, 'src/x.ts', 'display path relative to projectRoot');
    assert.equal(rows[0].total, 2);
    assert.equal(rows[0].covered, 1);
    assert.equal(rows[0].pct, 50);
  });

  test('excludes test files when fsTree paths use Windows separators', (assert) => {
    // Regression: on Windows the two sides arrive in different shapes — fsTree gives OS paths
    // (backslashes) while coverage keys come from the source map (always `/`). Comparing them
    // raw never matched, so test files leaked into the report. Simulated here so the platform
    // bug is reproducible on any OS.
    const projectRoot = 'D:\\a\\qunitx-cli\\qunitx-cli';
    const collector: CoverageFileMap = new Map([
      [
        'D:/a/qunitx-cli/qunitx-cli/src/x.ts',
        { coverable: new Set([1]), covered: new Map([[1, 1]]), sourceContent: null },
      ],
      [
        'D:/a/qunitx-cli/qunitx-cli/test/x-test.ts',
        { coverable: new Set([1]), covered: new Map([[1, 1]]), sourceContent: null },
      ],
    ]);
    const rows = Coverage.Report.buildRows(
      collector,
      new Set(['D:\\a\\qunitx-cli\\qunitx-cli\\test\\x-test.ts']),
      projectRoot,
    );
    assert.equal(rows.length, 1, 'backslash test path still excludes the forward-slash key');
    assert.equal(rows[0].displayPath, 'src/x.ts', 'display path is POSIX + project-relative');
  });

  test('excludes test files when the source map yields project-relative paths', (assert) => {
    // The map can also hand back an already-relative path (Windows outDir normalization);
    // it must still line up with the absolute fsTree entry.
    const rows = Coverage.Report.buildRows(
      new Map([
        ['test/x-test.ts', { coverable: new Set([1]), covered: new Map(), sourceContent: null }],
        ['src/x.ts', { coverable: new Set([1]), covered: new Map(), sourceContent: null }],
      ]),
      new Set(['/proj/test/x-test.ts']),
      '/proj',
    );
    assert.equal(rows.length, 1, 'relative coverage key matches the absolute test entry');
    assert.equal(rows[0].displayPath, 'src/x.ts');
  });

  test('buildLcov emits DA/LF/LH lines with hit counts', (assert) => {
    const rows = Coverage.Report.buildRows(
      new Map([
        [
          '/proj/tmp/src/x.ts',
          { coverable: new Set([1, 2]), covered: new Map([[1, 3]]), sourceContent: null },
        ],
      ]),
      new Set(),
      '/proj/tmp',
    );
    const lcov = Coverage.Report.buildLcov(rows);
    assert.true(lcov.includes('SF:src/x.ts'), 'source file line');
    assert.true(lcov.includes('DA:1,3'), 'covered line with hit count');
    assert.true(lcov.includes('DA:2,0'), 'missed line with zero count');
    assert.true(lcov.includes('LF:2'), 'lines found');
    assert.true(lcov.includes('LH:1'), 'lines hit');
    assert.true(lcov.trimEnd().endsWith('end_of_record'), 'record terminator');
  });
});
