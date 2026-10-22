import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as ImportMap from '../../lib/setup/import-map.ts';
import { tempDir } from '../helpers/temp-dir.ts';

/** Writes `files` (path → contents; objects are JSON) under `root`. */
async function writeTree(root: string, files: Record<string, unknown>): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([file, contents]) => {
      const target = path.join(root, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(
        target,
        typeof contents === 'string' ? contents : JSON.stringify(contents),
      );
    }),
  );
}

// An absolute root on this platform: `/p` on POSIX, `C:\\p` on Windows, where the URL gains a drive.
const P = path.resolve(path.sep, 'p');

/** The `/@fs` URL of a path under `root`. */
const url = (root: string, file: string, isDirectory = false) =>
  ImportMap.toFsUrl(path.join(root, file), isDirectory);

module('Setup | ImportMap | resolveExports', { concurrency: true }, () => {
  test('a string or a conditions object is the main entry, and only the main entry', (assert) => {
    assert.equal(ImportMap.resolveExports('./index.js', '.'), './index.js');
    assert.equal(
      ImportMap.resolveExports({ import: './esm.js', require: './cjs.js' }, '.'),
      './esm.js',
    );
    assert.equal(ImportMap.resolveExports('./index.js', './sub'), null);
  });

  test('the first matching condition in the package author order wins', (assert) => {
    const exports = {
      '.': { node: './node.js', browser: './browser.js', default: './default.js' },
    };
    assert.equal(ImportMap.resolveExports(exports, '.'), './browser.js');
    assert.equal(
      ImportMap.resolveExports({ '.': { default: './default.js', browser: './browser.js' } }, '.'),
      './default.js',
      'default listed first wins — key order is priority',
    );
  });

  test('node, require, deno and types never match: the page is a browser', (assert) => {
    const exports = {
      '.': { types: './a.d.ts', deno: './deno.js', node: './node.js', require: './a.cjs' },
    };
    assert.equal(ImportMap.resolveExports(exports, '.'), null);
  });

  test('nested conditions and fallback arrays resolve to the first target that does', (assert) => {
    const exports = {
      '.': { browser: { import: './browser.mjs' }, default: './default.js' },
      './array': [{ require: './a.cjs' }, './array.js'],
    };
    assert.equal(ImportMap.resolveExports(exports, '.'), './browser.mjs');
    assert.equal(ImportMap.resolveExports(exports, './array'), './array.js');
  });

  test('patterns substitute the matched text, and the longest prefix wins', (assert) => {
    const exports = {
      './*': './dist/*.js',
      './utils/*': './src/utils/*.js',
      './internal/*': null,
    };
    assert.equal(ImportMap.resolveExports(exports, './utils/date'), './src/utils/date.js');
    assert.equal(ImportMap.resolveExports(exports, './other'), './dist/other.js');
    assert.equal(ImportMap.resolveExports(exports, './internal/x'), null, 'null excludes');
  });
});

module('Setup | ImportMap | packageEntries', { concurrency: true }, () => {
  test('no exports: the browser/module/main entry, extension added, plus the whole directory', (assert) => {
    assert.deepEqual(
      ImportMap.packageEntries('a', path.join(P, 'node_modules/a'), { main: 'lib/index' }),
      {
        a: url(P, 'node_modules/a/lib/index.js'),
        'a/': url(P, 'node_modules/a', true),
      },
    );
    assert.deepEqual(
      ImportMap.packageEntries('b', path.join(P, 'node_modules/b'), {
        main: 'cjs.js',
        module: 'esm.js',
        browser: 'browser.js',
      }).b,
      url(P, 'node_modules/b/browser.js'),
      'a string `browser` field beats `module`, which beats `main`',
    );
    assert.deepEqual(
      ImportMap.packageEntries('c', path.join(P, 'node_modules/c'), {}).c,
      url(P, 'node_modules/c/index.js'),
    );
  });

  test('exports: every subpath, with patterns as prefixes where the map can express them', (assert) => {
    const entries = ImportMap.packageEntries(
      '@scope/pkg',
      path.join(P, 'node_modules/@scope/pkg'),
      {
        exports: {
          '.': { import: './index.js', require: './index.cjs' },
          './helpers': './src/helpers.js',
          './icons/*': './dist/icons/*',
          './locales/*.json': './data/locales/*.json',
          './feature-*': './features/*.mjs',
          './package.json': './package.json',
          './node-only': { node: './node-only.js' },
        },
      },
    );
    assert.deepEqual(entries, {
      '@scope/pkg': url(P, 'node_modules/@scope/pkg/index.js'),
      '@scope/pkg/helpers': url(P, 'node_modules/@scope/pkg/src/helpers.js'),
      '@scope/pkg/icons/': url(P, 'node_modules/@scope/pkg/dist/icons', true),
      '@scope/pkg/locales/': url(P, 'node_modules/@scope/pkg/data/locales', true),
      '@scope/pkg/package.json': url(P, 'node_modules/@scope/pkg/package.json'),
    });
  });

  test('exports with no subpaths and no browser condition contributes nothing', (assert) => {
    assert.deepEqual(
      ImportMap.packageEntries('n', path.join(P, 'node_modules/n'), {
        exports: { node: './n.js' },
      }),
      {},
    );
  });
});

module('Setup | ImportMap | URLs and parsing', { concurrency: true }, () => {
  test('toFsUrl and fromFsUrl round-trip a path, escapes included', (assert) => {
    const file = path.join(P, 'a dir', 'ünï.ts');
    assert.equal(ImportMap.fromFsUrl(ImportMap.toFsUrl(file)), file);
    assert.equal(ImportMap.fromFsUrl('/tests.js'), null);
    assert.true(ImportMap.toFsUrl(P, true).endsWith('/p/'));
  });

  test('parseJsonc drops comments and trailing commas but not // inside strings', (assert) => {
    assert.deepEqual(
      ImportMap.parseJsonc(
        '{\n  // line comment\n  "imports": { "x": "https://esm.sh/x", /* block */ },\n}',
      ),
      { imports: { x: 'https://esm.sh/x' } },
    );
  });

  test('merge overlays imports entry by entry and scopes scope by scope', (assert) => {
    assert.deepEqual(
      ImportMap.merge(
        { imports: { a: '1', b: '1' }, scopes: { '/s/': { a: '1' } } },
        { imports: { b: '2' }, scopes: { '/s/': { c: '2' }, '/t/': { d: '2' } } },
      ),
      { imports: { a: '1', b: '2' }, scopes: { '/s/': { a: '1', c: '2' }, '/t/': { d: '2' } } },
    );
  });
});

module('Setup | ImportMap | build', { concurrency: true }, () => {
  test('a nested second version of a package is scoped to the importer that sees it', async (assert) => {
    await using dir = await tempDir('import-map-nested');
    const root = await fs.realpath(dir.path);
    await writeTree(root, {
      'package.json': { name: 'app', dependencies: { a: '1', shared: '2' } },
      'node_modules/shared/package.json': { name: 'shared', version: '2.0.0', exports: './v2.js' },
      'node_modules/a/package.json': {
        name: 'a',
        exports: './a.js',
        dependencies: { shared: '1' },
      },
      'node_modules/a/node_modules/shared/package.json': { name: 'shared', exports: './v1.js' },
    });

    const { importMap, roots } = await ImportMap.build(root);

    assert.equal(importMap.imports.shared, url(root, 'node_modules/shared/v2.js'));
    assert.equal(importMap.imports.a, url(root, 'node_modules/a/a.js'));
    assert.deepEqual(importMap.scopes[url(root, 'node_modules/a', true)], {
      shared: url(root, 'node_modules/a/node_modules/shared/v1.js'),
    });
    assert.equal(importMap.imports.qunitx, ImportMap.EMBEDDED_QUNITX_URL, 'no qunitx installed');
    assert.true(roots.includes(path.join(root, 'node_modules/a/node_modules/shared')));
  });

  test('a hoisted transitive dependency lands in imports, where every module finds it', async (assert) => {
    await using dir = await tempDir('import-map-hoisted');
    const root = await fs.realpath(dir.path);
    await writeTree(root, {
      'package.json': { name: 'app', devDependencies: { a: '1' } },
      'node_modules/a/package.json': { name: 'a', main: 'a.js', dependencies: { b: '1' } },
      'node_modules/b/package.json': { name: 'b', module: 'b.mjs' },
    });

    const { importMap } = await ImportMap.build(root);

    assert.equal(importMap.imports.b, url(root, 'node_modules/b/b.mjs'));
    assert.deepEqual(importMap.scopes, {});
  });

  test('deno.json, then package.json#qunitx.importMap, override node_modules in that order', async (assert) => {
    await using dir = await tempDir('import-map-layers');
    const root = await fs.realpath(dir.path);
    await writeTree(root, {
      'package.json': {
        name: 'app',
        exports: { '.': './src/index.ts' },
        imports: { '#db': './src/db.ts' },
        dependencies: { local: '1' },
        qunitx: { importMap: './maps/test.json' },
      },
      'node_modules/local/package.json': {
        name: 'local',
        exports: { '.': './l.js', './x': './x.js' },
      },
      'deno.jsonc': `{
        // Deno-style specifiers become URLs the page can load.
        "imports": {
          "@std/assert": "jsr:@std/assert@^1",
          "local/x": "npm:local@^1/x",
          "remote": "npm:not-installed@2",
          "~/": "./src/",
          "overridden": "./deno.ts",
        },
      }`,
      'maps/test.json': {
        imports: { overridden: '../user.ts' },
        scopes: { './': { s: './s.ts' } },
      },
    });

    const { importMap } = await ImportMap.build(root);

    assert.equal(importMap.imports.app, url(root, 'src/index.ts'), 'self-reference');
    assert.equal(importMap.imports['#db'], url(root, 'src/db.ts'), 'subpath imports');
    assert.equal(importMap.imports['@std/assert'], 'https://esm.sh/jsr/@std/assert@^1');
    assert.equal(
      importMap.imports['local/x'],
      url(root, 'node_modules/local/x.js'),
      'npm: prefers the install',
    );
    assert.equal(importMap.imports.remote, 'https://esm.sh/not-installed@2');
    assert.equal(importMap.imports['~/'], url(root, 'src', true));
    assert.equal(
      importMap.imports.overridden,
      url(root, 'user.ts'),
      'the user map wins, relative to itself',
    );
    assert.deepEqual(importMap.scopes[url(root, 'maps', true)], { s: url(root, 'maps/s.ts') });
  });

  test('an unreadable or malformed user import map is a declared failure', async (assert) => {
    await using dir = await tempDir('import-map-bad');
    const root = await fs.realpath(dir.path);
    await writeTree(root, { 'package.json': { qunitx: { importMap: './missing.json' } } });
    await assert.rejects(ImportMap.build(root), (error: Error) =>
      ImportMap.ImportMapUnreadable.is(error),
    );

    await writeTree(root, { 'package.json': { qunitx: { importMap: { imports: [] } } } });
    await assert.rejects(ImportMap.build(root), (error: Error) =>
      ImportMap.ImportMapUnreadable.is(error),
    );
  });
});
