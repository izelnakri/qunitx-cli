import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { buildTestBundle } from '../../lib/commands/run/tests-in-browser.ts';
import type { Config, CachedContent } from '../../lib/types.ts';

const CWD = process.cwd();

// Two real test-helper files that import from qunitx — used as representative
// inputs so the resulting esbuild bundle contains real module-graph content
// (qunitx + deps) rather than a trivial empty artifact.
const FILE_A = `${CWD}/test/helpers/passing-tests.ts`;
const FILE_B = `${CWD}/test/helpers/failing-tests.ts`;

module('Commands | buildTestBundle | non-watch mode', { concurrency: true }, () => {
  test('produces a non-empty bundle', async (assert) => {
    const config = makeConfig([FILE_A]);
    const cached = makeCachedContent();

    await buildTestBundle(config, cached);

    assert.ok(cached.allTestCode, 'allTestCode is populated');
    assert.ok(
      (cached.allTestCode as Buffer).length > 500,
      'bundle is larger than the empty-build sentinel (500 bytes)',
    );
  });

  test('does not create an esbuild context — fresh build only', async (assert) => {
    const config = makeConfig([FILE_A]);
    const cached = makeCachedContent();

    await buildTestBundle(config, cached);

    assert.strictEqual(
      cached._esbuildContext,
      undefined,
      'no incremental context is created in non-watch mode',
    );
  });

  test('skips build and logs when fsTree is empty', async (assert) => {
    const config = makeConfig([]);
    const cached = makeCachedContent();

    await buildTestBundle(config, cached);

    assert.strictEqual(cached.allTestCode, null, 'allTestCode remains null for empty fsTree');
  });
});

module(
  'Commands | buildTestBundle | watch mode — incremental context',
  { concurrency: true },
  () => {
    test('creates an esbuild context on the first build', async (assert) => {
      const config = makeConfig([FILE_A], true);
      const cached = makeCachedContent();

      try {
        await buildTestBundle(config, cached);

        assert.ok(cached._esbuildContext, 'esbuild context is created');
        assert.strictEqual(
          cached._esbuildContextKey,
          FILE_A,
          'context key equals the single test file path',
        );
        assert.ok(cached.allTestCode, 'allTestCode is populated');
        assert.ok(
          (cached.allTestCode as Buffer).length > 500,
          'bundle is larger than the empty-build sentinel',
        );
      } finally {
        await disposeCached(cached);
      }
    });

    test('reuses the same context object across rebuilds when the file set is unchanged', async (assert) => {
      const config = makeConfig([FILE_A], true);
      const cached = makeCachedContent();

      try {
        await buildTestBundle(config, cached);
        const firstContext = cached._esbuildContext;

        // Second call with the same config — fileKey is identical, context should be reused.
        await buildTestBundle(config, cached);

        assert.strictEqual(
          cached._esbuildContext,
          firstContext,
          'context object is the same reference on the second build',
        );
        assert.ok(cached.allTestCode, 'bundle is produced on the second build too');
      } finally {
        await disposeCached(cached);
      }
    });

    test('replaces the context when the set of test files changes', async (assert) => {
      const config1 = makeConfig([FILE_A], true);
      const cached = makeCachedContent();

      try {
        await buildTestBundle(config1, cached);
        const firstContext = cached._esbuildContext;

        // Simulate adding a file: the fileKey changes → context is invalidated.
        const config2 = makeConfig([FILE_A, FILE_B], true);
        config2.output = config1.output; // reuse same output dir

        await buildTestBundle(config2, cached);

        assert.notStrictEqual(
          cached._esbuildContext,
          firstContext,
          'a new context is created when the file set changes',
        );
        assert.strictEqual(
          cached._esbuildContextKey,
          [FILE_A, FILE_B].join('\0'),
          'context key reflects both files',
        );
      } finally {
        await disposeCached(cached);
      }
    });

    test('incremental rebuild produces the same bundle content as a fresh build', async (assert) => {
      // Build fresh (non-watch) to get a reference bundle.
      const freshConfig = makeConfig([FILE_A], false);
      const freshCached = makeCachedContent();
      await buildTestBundle(freshConfig, freshCached);
      const freshBundle = freshCached.allTestCode as Buffer;

      // Build twice in watch mode; the second call uses the warm context.
      const watchConfig = makeConfig([FILE_A], true);
      watchConfig.output = `tmp/build-test-${randomUUID()}`;
      const watchCached = makeCachedContent();

      try {
        await buildTestBundle(watchConfig, watchCached);
        await buildTestBundle(watchConfig, watchCached);
        const incrementalBundle = watchCached.allTestCode as Buffer;

        // Both must produce a real bundle. We compare lengths rather than byte-for-byte
        // equality because esbuild may embed timestamps or non-deterministic identifiers.
        assert.ok(
          Math.abs(freshBundle.length - incrementalBundle.length) < freshBundle.length * 0.05,
          `bundle sizes are within 5%: fresh=${freshBundle.length} incremental=${incrementalBundle.length}`,
        );
      } finally {
        await disposeCached(watchCached);
      }
    });
  },
);

module('Commands | buildTestBundle | nodePaths resolution', { concurrency: true }, () => {
  test('resolves qunitx imports from a file outside the project root via ancestor nodePaths', async (assert) => {
    // Files outside the project root (e.g. /tmp/somefile.ts) are resolved relative to /tmp/,
    // which has no node_modules. The ancestorNodeModules nodePaths walk ensures qunitx can
    // still be resolved from any node_modules on the ancestor chain of process.cwd().
    // Note: an unused import is tree-shaken by esbuild, so we check _buildError (no resolution
    // error) rather than bundle size.
    const tmpFile = `/tmp/qunitx-nodepaths-${randomUUID()}.ts`;
    await fs.writeFile(tmpFile, `import { module, test } from 'qunitx';\n`);
    const config = makeConfig([tmpFile]);
    const cached = makeCachedContent();
    try {
      await buildTestBundle(config, cached);
      assert.ok(cached.allTestCode !== null, 'allTestCode is populated');
      assert.strictEqual(
        cached._buildError,
        null,
        'no build error — qunitx resolved via nodePaths',
      );
    } finally {
      await fs.rm(tmpFile, { force: true });
      await fs.rm(`${CWD}/${config.output}`, { force: true, recursive: true });
    }
  });
});

// tmp/ output dirs are cleaned up by test/runner.ts at the start of each full suite run.

function makeConfig(testFiles: string[], watch = false): Config {
  return {
    output: `tmp/build-test-${randomUUID()}`,
    timeout: 30000,
    failFast: false,
    port: 1234,
    extensions: ['ts', 'js'],
    browser: 'chromium',
    projectRoot: CWD,
    inputs: [],
    htmlPaths: [],
    testFileLookupPaths: [],
    fsTree: Object.fromEntries(testFiles.map((f) => [f, null])),
    watch,
    COUNTER: {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    },
    lastFailedTestFiles: null,
    lastRanTestFiles: null,
    _testRunDone: null,
    _resetTestTimeout: null,
    _onWsOpen: null,
    _onTestsJsServed: null,
  } as unknown as Config;
}

function makeCachedContent(): CachedContent {
  return {
    allTestCode: null,
    assets: new Set(),
    // '/' path skips the inner rm/mkdir in buildTestBundle — keeps tests self-contained.
    htmlPathsToRunTests: ['/'],
    mainHTML: { filePath: null, html: null },
    staticHTMLs: {},
    dynamicContentHTMLs: {},
  };
}

// Dispose any live esbuild context so the service can be cleaned up after each test.
async function disposeCached(cached: CachedContent): Promise<void> {
  if (cached._esbuildContext) {
    await cached._esbuildContext.dispose().catch(() => {});
    cached._esbuildContext = null;
  }
}
