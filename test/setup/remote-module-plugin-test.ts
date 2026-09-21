import esbuild from 'esbuild';
import { module, test } from 'qunitx';
import { loaderFor, remoteModulePlugin } from '../../lib/setup/remote-module-plugin.ts';
import { staticServer } from '../helpers/static-server.ts';
import '../helpers/custom-asserts.ts';

// The plugin is three rules, and each of them is a thing that goes wrong when it is missing: a
// URL nobody claims, a relative import resolved against the wrong root, and a bare specifier
// fetched from a server that never heard of it.

module('Setup | remote module plugin | which loader', { concurrency: true }, () => {
  test('the extension decides, because a server’s content type does not', (assert) => {
    assert.strictEqual(loaderFor('https://x/a-test.ts'), 'ts');
    assert.strictEqual(loaderFor('https://x/a-test.tsx'), 'tsx');
    assert.strictEqual(loaderFor('https://x/a.mts'), 'ts');
    assert.strictEqual(loaderFor('https://x/a.jsx'), 'jsx');
    assert.strictEqual(loaderFor('https://x/data.json'), 'json');
  });

  test('a query is not an extension, and an extensionless URL is JavaScript', (assert) => {
    assert.strictEqual(loaderFor('https://x/a-test.js?v=2'), 'js');
    assert.strictEqual(loaderFor('https://x/a-test.ts#34'), 'ts');
    // Which is the same guess a browser makes, and the common case for a CDN route.
    assert.strictEqual(loaderFor('https://x/api/tests'), 'js');
  });

  test('a file that is plainly not a module is refused by name', (assert) => {
    // esbuild's own answer is `No loader is configured for ".html" files`, which does not say
    // which of the run's inputs produced it.
    let message = '';
    try {
      loaderFor('https://x/index.html');
    } catch (error) {
      message = (error as Error).message;
    }

    assert.includes(message, 'https://x/index.html');
    assert.includes(message, 'not a module');
  });
});

module('Setup | remote module plugin | bundling', { concurrency: true }, () => {
  test('a URL entry point is fetched and bundled', async (assert) => {
    await using server = await staticServer({
      files: { '/tests/a-test.js': 'export const answer = 42;' },
    });
    const built = await bundle(`${server.url}/tests/a-test.js`);

    assert.includes(built, '42');
  });

  test('a relative import resolves against the URL, not against this disk', async (assert) => {
    await using server = await staticServer({
      files: {
        '/tests/a-test.js': "import { total } from './helpers.js';\nexport const sum = total();",
        '/tests/helpers.js': 'export function total() {\n  return 3;\n}',
      },
    });
    const built = await bundle(`${server.url}/tests/a-test.js`);

    assert.includes(built, 'return 3');
    assert.deepEqual(server.requests, ['/tests/a-test.js', '/tests/helpers.js']);
  });

  test('a `../` import climbs the server’s tree, as it would in a browser', async (assert) => {
    await using server = await staticServer({
      files: {
        '/tests/deep/a-test.js':
          "import { total } from '../helpers.js';\nexport const s = total();",
        '/tests/helpers.js': 'export function total() {\n  return 7;\n}',
      },
    });
    const built = await bundle(`${server.url}/tests/deep/a-test.js`);

    assert.includes(built, 'return 7');
  });

  test('a bare specifier resolves LOCALLY — a remote test imports the runtime running it', async (assert) => {
    await using server = await staticServer({
      files: { '/tests/a-test.js': "import { test } from 'qunitx';\nexport const t = test;" },
    });
    const built = await bundle(`${server.url}/tests/a-test.js`);

    // Fetched exactly one file: `qunitx` went to node_modules, not to the server.
    assert.deepEqual(server.requests, ['/tests/a-test.js']);
    assert.true(built.length > 100, 'and the runtime came along in the bundle');
  });

  test('a module imported twice is fetched once', async (assert) => {
    await using server = await staticServer({
      files: {
        '/tests/a-test.js': "import './shared.js';\nimport './b.js';",
        '/tests/b.js': "import './shared.js';",
        '/tests/shared.js': 'export const shared = 1;',
      },
    });
    await bundle(`${server.url}/tests/a-test.js`);

    assert.strictEqual(server.requests.filter((at) => at === '/tests/shared.js').length, 1);
  });

  test('TypeScript is compiled, because the extension said so', async (assert) => {
    await using server = await staticServer({
      files: { '/tests/a-test.ts': 'const name: string = "Ada";\nexport const who = name;' },
    });
    const built = await bundle(`${server.url}/tests/a-test.ts`);

    assert.includes(built, 'Ada');
    assert.notIncludes(built, ': string', 'the annotation is gone, so it was parsed as TS');
  });

  test('a 404 fails the build with the URL and the status in it', async (assert) => {
    await using server = await staticServer({ files: {} });
    const failed = await bundle(`${server.url}/tests/missing.js`).catch((error: Error) => error);

    assert.includes(String((failed as Error).message), '/tests/missing.js');
    assert.includes(String((failed as Error).message), '404');
  });
});

/** One bundle, with only this plugin — so a pass is this plugin's doing and nothing else's. */
async function bundle(entry: string): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    logLevel: 'silent',
    format: 'esm',
    plugins: [remoteModulePlugin(process.cwd())],
  });

  return result.outputFiles?.[0]?.text ?? '';
}
