import { module, test } from 'qunitx';
import {
  expandRemoteGlob,
  fetchRemote,
  isRemoteGlob,
  isRemoteInput,
  remoteDirectoryPattern,
} from '../../lib/setup/remote-inputs.ts';
import { staticServer } from '../helpers/static-server.ts';
import '../helpers/custom-asserts.ts';

// A server has no `stat` and no `readdir`, so everything a local input gets for free has to be
// asked for. These are the answers — and the three shapes of listing a real server gives.

module('Setup | remote inputs | telling one apart', { concurrency: true }, () => {
  test('http and https are remote; a path is not', (assert) => {
    assert.true(isRemoteInput('https://example.com/tests/cart-test.js'));
    assert.true(isRemoteInput('http://localhost:3000/a.js'));
    assert.true(isRemoteInput('HTTPS://EXAMPLE.COM/a.js'), 'a scheme is case-insensitive');
    assert.false(isRemoteInput('test/cart-test.ts'));
    assert.false(isRemoteInput('/abs/cart-test.ts'));
    // A `file:` URL is a path spelled the long way, and fs can read it.
    assert.false(isRemoteInput('file:///tmp/a.ts'));
    assert.false(isRemoteInput('C:\\tests\\a.ts'));
  });

  test('a pattern is a pattern; a query string only looks like one', (assert) => {
    assert.true(isRemoteGlob('https://x/tests/*-test.js'));
    assert.true(isRemoteGlob('https://x/tests/**/*.ts'));
    assert.true(isRemoteGlob('https://x/t/a.{ts,js}'));
    assert.false(isRemoteGlob('https://x/tests/a-test.js'));
    // The characters after a `?` belong to the query, and reading them as a glob would send the
    // walk looking for a directory that was never named.
    assert.false(isRemoteGlob('https://x/tests/a-test.js?v=2'));
    assert.false(isRemoteGlob('https://x/a.js#34'));
  });

  test('a directory is told from a file the way the local dedupe already tells them', (assert) => {
    assert.strictEqual(remoteDirectoryPattern('https://x/tests/'), 'https://x/tests/**');
    assert.strictEqual(remoteDirectoryPattern('https://x/tests'), 'https://x/tests/**');
    assert.strictEqual(remoteDirectoryPattern('https://x/tests/a-test.js'), null);
    assert.strictEqual(
      remoteDirectoryPattern('https://x/a.ts?v=2'),
      null,
      'the query is not a name',
    );
  });
});

module('Setup | remote inputs | fetching one', { concurrency: true }, () => {
  test('the text comes back, and a second ask does not reach the server', async (assert) => {
    await using server = await staticServer({ files: { '/a.js': 'export const a = 1;' } });
    const cache = new Map<string, string>();

    assert.strictEqual(await fetchRemote(`${server.url}/a.js`, cache), 'export const a = 1;');
    assert.strictEqual(await fetchRemote(`${server.url}/a.js`, cache), 'export const a = 1;');
    assert.deepEqual(server.requests, ['/a.js'], 'fetched once, however often it is imported');
  });

  test('a fresh cache fetches again, which is what a new build wants', async (assert) => {
    await using server = await staticServer({ files: { '/a.js': 'export const a = 1;' } });
    await fetchRemote(`${server.url}/a.js`, new Map());
    await fetchRemote(`${server.url}/a.js`, new Map());

    assert.strictEqual(server.requests.length, 2, 'a watch rebuild sees the file as it is now');
  });

  test('a 404 names the status, not `fetch failed`', async (assert) => {
    await using server = await staticServer({ files: {} });
    const failed = await fetchRemote(`${server.url}/missing.js`, new Map()).catch(
      (error: Error) => error,
    );

    assert.includes(String((failed as Error).message), '404');
    assert.includes(String((failed as Error).message), '/missing.js', 'and which URL it was');
  });

  test('a refused connection is said in words', async (assert) => {
    // A port that was bound and then let go is the only one guaranteed to refuse: port 1 is on
    // the runtime's own blocked list and answers `bad port` before a socket is ever opened.
    const closed = await staticServer({ files: {} });
    const url = closed.url;
    await closed[Symbol.asyncDispose]();
    const failed = await fetchRemote(`${url}/a.js`, new Map()).catch((error: Error) => error);

    assert.includes(String((failed as Error).message), 'connection refused');
    // `fetch` reports this as `TypeError: fetch failed` with the code buried in an AggregateError
    // whose own message is empty. Unwrapping it is the whole reason this path exists.
    assert.notIncludes(String((failed as Error).message), 'fetch failed');
  });

  test('a URL that answers with a page is refused by name', async (assert) => {
    await using server = await staticServer({ files: { '/docs/a.js': 'export const a = 1;' } });
    // `/docs` is a directory here, so the server answers with its HTML index — which is exactly
    // what a bare origin or a login redirect does, and none of the three is a module.
    const failed = await fetchRemote(`${server.url}/docs`, new Map()).catch(
      (error: Error) => error,
    );

    assert.includes(String((failed as Error).message), 'web page, not a module');
  });

  test('a .js a server calls HTML is still a module — the guard reads the name', async (assert) => {
    await using server = await staticServer({
      files: { '/a.js': 'export const a = 1;' },
      types: { '/a.js': 'text/html; charset=utf-8' },
    });

    // Plenty of servers mislabel JavaScript. Refusing on the type alone would break them, so the
    // guard only fires where the URL never claimed to be a module either.
    assert.strictEqual(await fetchRemote(`${server.url}/a.js`, new Map()), 'export const a = 1;');
  });
});

module('Setup | remote inputs | expanding a glob', { concurrency: true }, () => {
  const suite = {
    '/tests/cart-test.js': 'export {};',
    '/tests/user-test.js': 'export {};',
    '/tests/helpers.js': 'export {};',
    '/tests/README.md': '# no',
    '/tests/deep/order-test.ts': 'export {};',
    '/tests/deep/deeper/edge-test.ts': 'export {};',
  };

  test('an HTML autoindex is read, which is what every static host gives for free', async (assert) => {
    await using server = await staticServer({ files: suite, index: 'html' });
    const found = await expandRemoteGlob(`${server.url}/tests/*-test.js`, ['js', 'ts'], new Map());

    assert.deepEqual(found, [
      `${server.url}/tests/cart-test.js`,
      `${server.url}/tests/user-test.js`,
    ]);
  });

  test('a JSON array of names is read too', async (assert) => {
    await using server = await staticServer({ files: suite, index: 'json' });
    const found = await expandRemoteGlob(`${server.url}/tests/*-test.js`, ['js'], new Map());

    assert.strictEqual(found.length, 2);
  });

  test('so is the `{ name, type }` array the GitHub contents API answers', async (assert) => {
    await using server = await staticServer({ files: suite, index: 'json-objects' });
    const found = await expandRemoteGlob(`${server.url}/tests/**/*-test.ts`, ['ts'], new Map());

    // `type: 'dir'` is what puts the slash back, and without the slash the walk never descends.
    assert.deepEqual(found, [
      `${server.url}/tests/deep/deeper/edge-test.ts`,
      `${server.url}/tests/deep/order-test.ts`,
    ]);
  });

  test('`**` walks down; a single star does not', async (assert) => {
    await using server = await staticServer({ files: suite });
    const shallow = await expandRemoteGlob(`${server.url}/tests/*-test.*`, ['js', 'ts'], new Map());
    const deep = await expandRemoteGlob(`${server.url}/tests/**/*-test.*`, ['js', 'ts'], new Map());

    assert.strictEqual(shallow.length, 2, 'the two beside the pattern');
    assert.strictEqual(deep.length, 4, 'and the two below them');
  });

  test('the run’s extensions filter the listing, as they filter a local walk', async (assert) => {
    await using server = await staticServer({ files: suite });
    const found = await expandRemoteGlob(`${server.url}/tests/**`, ['ts'], new Map());

    assert.strictEqual(found.length, 2, 'only the .ts files');
    assert.notIncludes(found.join(' '), 'README.md');
  });

  test('the answer is sorted, so a run does not depend on a server’s ordering', async (assert) => {
    await using server = await staticServer({ files: suite });
    const found = await expandRemoteGlob(`${server.url}/tests/**`, ['js', 'ts'], new Map());

    assert.deepEqual([...found].sort(), found);
  });

  test('a pattern matching nothing is an empty answer, not a failure', async (assert) => {
    await using server = await staticServer({ files: suite });

    assert.deepEqual(
      await expandRemoteGlob(`${server.url}/tests/*-nope.js`, ['js'], new Map()),
      [],
    );
  });

  test('a server that will not be listed says so, naming the directory', async (assert) => {
    await using server = await staticServer({ files: suite, index: 'none' });
    const failed = await expandRemoteGlob(`${server.url}/tests/*.js`, ['js'], new Map()).catch(
      (error: Error) => error,
    );

    assert.includes(String((failed as Error).message), '/tests/');
    assert.includes(String((failed as Error).message), '404');
  });

  test('a listing that is not the JSON it claims is named as such', async (assert) => {
    await using server = await staticServer({
      files: { '/broken/': 'not json at all' },
      types: { '/broken/': 'application/json' },
    });
    const failed = await expandRemoteGlob(`${server.url}/broken/*.js`, ['js'], new Map()).catch(
      (error: Error) => error,
    );

    assert.includes(String((failed as Error).message), 'not valid JSON');
  });

  test('a JSON listing of the wrong shape says which shapes it reads', async (assert) => {
    await using server = await staticServer({
      files: { '/odd/': '{"entries":["a.js"]}' },
      types: { '/odd/': 'application/json' },
    });
    const failed = await expandRemoteGlob(`${server.url}/odd/*.js`, ['js'], new Map()).catch(
      (error: Error) => error,
    );

    assert.includes(String((failed as Error).message), 'neither an array nor');
  });

  test('a link out of the directory is not one of its files', async (assert) => {
    // An autoindex is free to link anywhere: an absolute path back to the root, a sibling tree,
    // another host entirely. None of those is a file IN this directory, and following one would
    // put a URL in the run that the pattern never named.
    await using server = await staticServer({
      files: {
        '/wild/':
          '<html><body>' +
          '<a href="/elsewhere/escaped.js">up and out</a>' +
          '<a href="http://example.invalid/remote.js">another host</a>' +
          '<a href="ok.js">ok.js</a>' +
          '</body></html>',
      },
      types: { '/wild/': 'text/html' },
    });
    const found = await expandRemoteGlob(`${server.url}/wild/*.js`, ['js'], new Map());

    assert.deepEqual(found, [`${server.url}/wild/ok.js`]);
  });

  test('`**` does not follow a link out of the tree it was pointed at', async (assert) => {
    // The one the output filter cannot catch: an escaping DIRECTORY link is not a file, so no
    // URL leaks into the answer — but a recursive walk would go and fetch it, wandering off into
    // a site that was never named. The proof is what the server was asked for.
    await using server = await staticServer({
      files: {
        '/tests/': '<html><a href="/other/">elsewhere</a><a href="inner/">inner/</a></html>',
        '/tests/inner/': '<html><a href="a-test.js">a-test.js</a></html>',
        '/other/': '<html><a href="b-test.js">b-test.js</a></html>',
      },
      types: {
        '/tests/': 'text/html',
        '/tests/inner/': 'text/html',
        '/other/': 'text/html',
      },
    });
    const found = await expandRemoteGlob(`${server.url}/tests/**/*-test.js`, ['js'], new Map());

    assert.deepEqual(found, [`${server.url}/tests/inner/a-test.js`]);
    assert.notIncludes(server.requests.join(' '), '/other/', 'it never went there');
  });

  test('a listing never escapes the directory it lists', async (assert) => {
    await using server = await staticServer({ files: suite });
    const found = await expandRemoteGlob(`${server.url}/tests/deep/**`, ['ts'], new Map());

    // The `../` every autoindex emits would otherwise walk back up and out of the pattern.
    for (const url of found) assert.includes(url, '/tests/deep/');
  });
});
