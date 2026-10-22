import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as NoBundle from '../../lib/setup/no-bundle.ts';
import * as ImportMap from '../../lib/setup/import-map.ts';
import * as SourceMap from '../../lib/utils/source-map.ts';
import { HTTPServer } from '../../lib/web/index.ts';
import { tempDir } from '../helpers/temp-dir.ts';

const EMPTY_MAP = { imports: {}, scopes: {} };

/** A listening server with the no-bundle routes over `root`, and a `get` that can send a Referer. */
async function serve(root: string, extraRoots: string[] = []) {
  const state = NoBundle.createState(root, { importMap: EMPTY_MAP, roots: [root] });
  const server = new HTTPServer();
  NoBundle.registerRoutes(server, state, () => extraRoots);
  await server.listen(0);
  const origin = `http://localhost:${(server._server.address() as { port: number }).port}`;
  const get = async (file: string, referer?: string) => {
    const response = await fetch(`${origin}${ImportMap.toFsUrl(file)}`, {
      headers: referer ? { referer: `${origin}${ImportMap.toFsUrl(referer)}` } : {},
    });
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      body: await response.text(),
    };
  };

  return { state, origin, get, [Symbol.asyncDispose]: () => server.close() };
}

module('Setup | NoBundle | page', { concurrency: true }, () => {
  test('the entry imports every test file in order, by /@fs URL, then signals tests-ready', (assert) => {
    const root = path.resolve(path.sep, 'proj');
    const [b, a] = ['test/b-test.ts', 'test/a-test.ts'].map((file) => path.join(root, file));
    const entry = NoBundle.entrySource([b, a], root);
    const files = JSON.parse(/const files = (.*);/.exec(entry)![1]);
    assert.deepEqual(files, [
      [ImportMap.toFsUrl(b), 'test/b-test.ts'],
      [ImportMap.toFsUrl(a), 'test/a-test.ts'],
    ]);
    assert.true(
      entry.trimEnd().includes("window.dispatchEvent(new CustomEvent('qunitx:tests-ready'))"),
    );
  });

  test('the import map comes first, and a specifier cannot close its script tag', (assert) => {
    const tags = NoBundle.scriptTags(
      { imports: { '</script><script>alert(1)//': '/x.js' }, scopes: {} },
      '<script>/* runtime */</script>',
      './tests.js',
    );
    const order = ['type="importmap"', '/* runtime */', 'autostart = false', 'type="module"'].map(
      (needle) => tags.indexOf(needle),
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
      'map, runtime, preconfig, entry',
    );
    assert.false(tags.includes('</script><script>alert'), 'the `<` is escaped inside the map');
  });
});

module('Setup | NoBundle | serving', { concurrency: true }, () => {
  test('TypeScript is type-stripped in place, so its lines and columns do not move', async (assert) => {
    await using dir = await tempDir('no-bundle-strip');
    const root = await fs.realpath(dir.path);
    const source = 'const answer: number = 42;\nexport { answer };\n';
    await fs.writeFile(path.join(root, 'a.ts'), source);
    await using server = await serve(root);

    const { status, type, body } = await server.get(path.join(root, 'a.ts'));

    assert.equal(status, 200);
    assert.equal(type, 'text/javascript; charset=utf-8');
    assert.equal(body.length, source.length);
    assert.equal(body, 'const answer         = 42;\nexport { answer };\n');
  });

  test('syntax stripping cannot erase is transformed, with a map back to the source', async (assert) => {
    await using dir = await tempDir('no-bundle-enum');
    const root = await fs.realpath(dir.path);
    const file = path.join(root, 'enum.ts');
    await fs.writeFile(
      file,
      'export enum Color {\n  Red,\n}\nthrow new Error(String(Color.Red));\n',
    );
    await using server = await serve(root);

    const { status, body } = await server.get(file);
    const served = server.state.modules.get(ImportMap.toFsUrl(file))!;
    const throwLine = body.split('\n').findIndex((line) => line.includes('throw')) + 1;

    assert.equal(status, 200);
    assert.notOk(body.includes('enum'), 'compiled away');
    assert.equal(SourceMap.lookupPosition(served.map!, throwLine, 1)?.line, 4);
    assert.equal(SourceMap.lookupPosition(served.map!, throwLine, 1)?.absolutePath, file);
  });

  test('a `.js` import of a `.ts` file serves the `.ts` file', async (assert) => {
    await using dir = await tempDir('no-bundle-js-ts');
    const root = await fs.realpath(dir.path);
    await fs.writeFile(path.join(root, 'util.ts'), 'export const x: 1 = 1;');
    await using server = await serve(root);

    const { status, body } = await server.get(path.join(root, 'util.js'));

    assert.equal(status, 200);
    assert.equal(body, 'export const x    = 1;');
  });

  test('a missing file, an extensionless import and a file outside the roots are explained', async (assert) => {
    await using dir = await tempDir('no-bundle-errors');
    await using outside = await tempDir('no-bundle-outside');
    const root = await fs.realpath(dir.path);
    const test = path.join(root, 'a-test.ts');
    await fs.writeFile(path.join(root, 'util.ts'), '');
    await fs.writeFile(path.join(outside.path, 'secret.js'), '');
    await using server = await serve(root);

    const missing = await server.get(path.join(root, 'nope.ts'), test);
    const extensionless = await server.get(path.join(root, 'util'), test);
    const forbidden = await server.get(
      path.join(await fs.realpath(outside.path), 'secret.js'),
      test,
    );

    assert.equal(missing.status, 404);
    assert.equal(missing.body, 'cannot find nope.ts (imported by a-test.ts)');
    assert.equal(extensionless.status, 404);
    assert.true(extensionless.body.includes('did you mean util.ts?'));
    assert.equal(forbidden.status, 403);
    assert.true(forbidden.body.includes('is outside the directories a --no-bundle run serves'));
    assert.deepEqual(NoBundle.loadErrorsFor(server.state, test), [
      missing.body,
      extensionless.body,
      forbidden.body,
    ]);
    assert.deepEqual(NoBundle.loadErrorsFor(server.state, path.join(root, 'b-test.ts')), []);
  });

  test('a syntax error is reported with the file it is in', async (assert) => {
    await using dir = await tempDir('no-bundle-syntax');
    const root = await fs.realpath(dir.path);
    await fs.writeFile(path.join(root, 'bad.ts'), 'const = ;');
    await using server = await serve(root);

    const { status, body } = await server.get(path.join(root, 'bad.ts'));

    assert.equal(status, 500);
    assert.true(body.startsWith('could not compile bad.ts:'), body);
  });

  test('the Referer of every request becomes an edge of the --changed import graph', async (assert) => {
    await using dir = await tempDir('no-bundle-graph');
    const root = await fs.realpath(dir.path);
    await fs.mkdir(path.join(root, 'lib'));
    await fs.writeFile(path.join(root, 'lib/a.ts'), '');
    await using server = await serve(root);

    await server.get(path.join(root, 'lib/a.ts'), path.join(root, 'a-test.ts'));

    assert.deepEqual(NoBundle.metafile(server.state, root), {
      inputs: { 'a-test.ts': { imports: [{ path: path.join('lib', 'a.ts') }] } },
    });
  });

  test('qunitx is served from the embedded runtime when the project has not installed it', async (assert) => {
    await using dir = await tempDir('no-bundle-runtime');
    await using server = await serve(dir.path);

    const response = await fetch(`${server.origin}${ImportMap.EMBEDDED_QUNITX_URL}`);

    assert.equal(response.status, 200);
    assert.true((await response.text()).includes('export {'));
  });
});

module('Setup | NoBundle | stack traces', { concurrency: true }, () => {
  test('a frame on a served module resolves to its file, with its source line', (assert) => {
    const state = NoBundle.createState('/proj', { importMap: EMPTY_MAP, roots: ['/proj'] });
    state.modules.set('/@fs/proj/test/a-test.ts', {
      absolutePath: '/proj/test/a-test.ts',
      code: '\n  assert.equal(1, 2);\n',
      source: '\n  assert.equal(1, 2);\n',
      map: null,
    });
    const decoder = NoBundle.decoder(state, '/proj/tmp');

    const { resolvedStack, firstUserFrame, firstUserSourceText } = SourceMap.resolveStack(
      'Error\n    at Object.<anonymous> (http://localhost:1234/@fs/proj/test/a-test.ts:2:10)\n    at http://localhost:1234/@qunitx/runtime.js:9:9',
      decoder,
      '/proj',
    );

    assert.equal(firstUserFrame, 'test/a-test.ts:2:10');
    assert.equal(firstUserSourceText, 'assert.equal(1, 2);');
    assert.true(
      resolvedStack.includes('at http://localhost:1234/@qunitx/runtime.js:9:9'),
      'unserved frames are kept',
    );
  });
});
