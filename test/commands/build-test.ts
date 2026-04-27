import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildTestBundle, bundleCacheKey } from '../../lib/commands/run/tests-in-browser.ts';
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
        // Parse the key rather than substring-checking — the JSON encoding escapes
        // backslashes on Windows, which makes substring assertions implicitly
        // platform-specific. The contract is "files are encoded in the key".
        const parsedKey = JSON.parse(cached._esbuildContextKey ?? '{}') as { files?: string[] };
        assert.ok(
          parsedKey.files?.includes(FILE_A),
          'context key encodes the single test file path',
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
        const newKey = JSON.parse(cached._esbuildContextKey ?? '{}') as { files?: string[] };
        assert.ok(
          newKey.files?.includes(FILE_A) && newKey.files?.includes(FILE_B),
          'context key encodes both files',
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

module('Commands | buildTestBundle | jsx automatic runtime', { concurrency: true }, () => {
  test('compiles a .tsx file using react/jsx-runtime by default', async (assert) => {
    const tmpFile = path.join(os.tmpdir(), `qunitx-jsx-react-${randomUUID()}.tsx`);
    await fs.writeFile(
      tmpFile,
      `import { module, test } from 'qunitx';\n` +
        `module('jsx', () => { test('renders', (a) => { const el = <div>x</div>; a.ok(el); }); });\n`,
    );
    const config = makeConfig([tmpFile]);
    const cached = makeCachedContent();
    try {
      await buildTestBundle(config, cached);
      const bundle = (cached.allTestCode as Buffer).toString('utf8');
      assert.strictEqual(cached._buildError, null, 'no build error');
      assert.ok(bundle.includes('react/jsx-runtime'), 'bundle pulls in react/jsx-runtime');
    } finally {
      await fs.rm(tmpFile, { force: true });
      await fs.rm(`${CWD}/${config.output}`, { force: true, recursive: true });
    }
  });

  test('honors @jsxImportSource pragma to switch the runtime to vue', async (assert) => {
    const tmpFile = path.join(os.tmpdir(), `qunitx-jsx-vue-${randomUUID()}.tsx`);
    await fs.writeFile(
      tmpFile,
      `/** @jsxImportSource vue */\n` +
        `import { module, test } from 'qunitx';\n` +
        `module('jsx', () => { test('renders', (a) => { const el = <div>x</div>; a.ok(el); }); });\n`,
    );
    const config = makeConfig([tmpFile]);
    const cached = makeCachedContent();
    try {
      await buildTestBundle(config, cached);
      const bundle = (cached.allTestCode as Buffer).toString('utf8');
      assert.strictEqual(cached._buildError, null, 'no build error');
      assert.ok(bundle.includes('vue/jsx-runtime'), 'bundle pulls in vue/jsx-runtime');
      assert.notOk(
        bundle.includes('react/jsx-runtime'),
        'react/jsx-runtime not included when pragma overrides the import source',
      );
    } finally {
      await fs.rm(tmpFile, { force: true });
      await fs.rm(`${CWD}/${config.output}`, { force: true, recursive: true });
    }
  });

  test('compiles a .jsx file using react/jsx-runtime by default', async (assert) => {
    const tmpFile = path.join(os.tmpdir(), `qunitx-jsx-ext-${randomUUID()}.jsx`);
    await fs.writeFile(
      tmpFile,
      `import { module, test } from 'qunitx';\n` +
        `module('jsx', () => { test('renders', (a) => { const el = <span>y</span>; a.ok(el); }); });\n`,
    );
    const config = makeConfig([tmpFile]);
    const cached = makeCachedContent();
    try {
      await buildTestBundle(config, cached);
      const bundle = (cached.allTestCode as Buffer).toString('utf8');
      assert.strictEqual(cached._buildError, null, 'no build error');
      assert.ok(bundle.includes('react/jsx-runtime'), '.jsx is parsed and JSX is transformed');
    } finally {
      await fs.rm(tmpFile, { force: true });
      await fs.rm(`${CWD}/${config.output}`, { force: true, recursive: true });
    }
  });

  test('does not transform JSX-like syntax inside a .ts file', async (assert) => {
    // .ts files (no x) are extension-gated by esbuild — no JSX transform applied. This guards
    // against accidental transforms from a future config change that would break TS-only codebases
    // using legitimate type-assertion or generic syntax that resembles JSX (e.g. `<T>(x: T)`).
    const tmpFile = path.join(os.tmpdir(), `qunitx-jsx-ts-${randomUUID()}.ts`);
    await fs.writeFile(
      tmpFile,
      `import { module, test } from 'qunitx';\n` +
        `module('plain ts', () => { test('runs', (a) => { a.ok(true); }); });\n`,
    );
    const config = makeConfig([tmpFile]);
    const cached = makeCachedContent();
    try {
      await buildTestBundle(config, cached);
      const bundle = (cached.allTestCode as Buffer).toString('utf8');
      assert.strictEqual(cached._buildError, null, 'no build error');
      assert.notOk(
        bundle.includes('jsx-runtime'),
        'no jsx-runtime import injected for plain TS files',
      );
    } finally {
      await fs.rm(tmpFile, { force: true });
      await fs.rm(`${CWD}/${config.output}`, { force: true, recursive: true });
    }
  });
});

module('Commands | buildTestBundle | esbuild plugins', { concurrency: true }, () => {
  test('user plugins are invoked during the build and can resolve virtual modules', async (assert) => {
    const tmpFile = path.join(os.tmpdir(), `qunitx-plugin-${randomUUID()}.ts`);
    await fs.writeFile(
      tmpFile,
      `import { module, test } from 'qunitx';\n` +
        `import { GREETING } from 'virtual:greeting';\n` +
        `module('plugin', () => { test('greets', (a) => { a.equal(GREETING, 'hi'); }); });\n`,
    );
    let setupCalls = 0;
    const virtualGreetingPlugin = {
      name: 'virtual-greeting',
      setup(build: import('esbuild').PluginBuild) {
        setupCalls++;
        build.onResolve({ filter: /^virtual:greeting$/ }, (args) => ({
          path: args.path,
          namespace: 'virtual-greeting',
        }));
        build.onLoad({ filter: /.*/, namespace: 'virtual-greeting' }, () => ({
          contents: `export const GREETING = 'hi';`,
          loader: 'ts',
        }));
      },
    };
    const config = makeConfig([tmpFile]);
    config.plugins = [virtualGreetingPlugin];
    const cached = makeCachedContent();
    try {
      await buildTestBundle(config, cached);
      const bundle = (cached.allTestCode as Buffer).toString('utf8');
      assert.strictEqual(cached._buildError, null, 'no build error');
      assert.equal(setupCalls, 1, 'plugin setup() invoked exactly once');
      assert.ok(
        bundle.includes(`'hi'`) || bundle.includes(`"hi"`),
        'virtual module contents are inlined into the bundle',
      );
    } finally {
      await fs.rm(tmpFile, { force: true });
      await fs.rm(`${CWD}/${config.output}`, { force: true, recursive: true });
    }
  });
});

module('Commands | buildTestBundle | nodePaths resolution', { concurrency: true }, () => {
  test('resolves qunitx imports from a file outside the project root via ancestor nodePaths', async (assert) => {
    // Files outside the project root (e.g. os.tmpdir() + '/foo.ts') are resolved relative to
    // their containing directory, which has no node_modules. The ancestorNodeModules nodePaths
    // walk ensures qunitx can still be resolved from any node_modules on the ancestor chain
    // of process.cwd(). os.tmpdir() is used (not hardcoded /tmp) so the test is portable to
    // Windows, where /tmp resolves to a non-existent D:\tmp.
    // Note: an unused import is tree-shaken by esbuild, so we check _buildError (no resolution
    // error) rather than bundle size.
    const tmpFile = path.join(os.tmpdir(), `qunitx-nodepaths-${randomUUID()}.ts`);
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

module('Commands | bundleCacheKey', { concurrency: true }, () => {
  // Regression contract: every BuildOption that varies between runs MUST be in the key.
  // If someone adds a new variable option (e.g. a future --debug toggle wiring through
  // to `sourcemap`) without updating bundleCacheKey, one of these tests should catch it.
  const baseOpts = { outfile: '/tmp/a/tests.js', target: ['chrome120'] };
  const baseFiles = ['/proj/a.ts', '/proj/b.ts'];

  test('same inputs produce the same key', (assert) => {
    assert.equal(bundleCacheKey(baseOpts, baseFiles), bundleCacheKey(baseOpts, baseFiles));
  });

  test('outfile change → different key (covers --output between daemon runs)', (assert) => {
    const k1 = bundleCacheKey({ ...baseOpts, outfile: '/tmp/a/tests.js' }, baseFiles);
    const k2 = bundleCacheKey({ ...baseOpts, outfile: '/tmp/b/tests.js' }, baseFiles);
    assert.notEqual(k1, k2);
  });

  test('target change → different key (covers --browser between daemon runs)', (assert) => {
    const k1 = bundleCacheKey({ ...baseOpts, target: ['chrome120'] }, baseFiles);
    const k2 = bundleCacheKey({ ...baseOpts, target: ['firefox115'] }, baseFiles);
    assert.notEqual(k1, k2);
  });

  test('test-file set change → different key (file added)', (assert) => {
    const k1 = bundleCacheKey(baseOpts, ['/proj/a.ts']);
    const k2 = bundleCacheKey(baseOpts, ['/proj/a.ts', '/proj/b.ts']);
    assert.notEqual(k1, k2);
  });

  test('test-file order change → different key (intentional — order affects bundle output)', (assert) => {
    const k1 = bundleCacheKey(baseOpts, ['/proj/a.ts', '/proj/b.ts']);
    const k2 = bundleCacheKey(baseOpts, ['/proj/b.ts', '/proj/a.ts']);
    assert.notEqual(k1, k2);
  });
});
