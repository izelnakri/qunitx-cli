import { module, test } from 'qunitx';
import { execute, shellFails } from '../helpers/shell.ts';
import { staticServer } from '../helpers/static-server.ts';
import '../helpers/custom-asserts.ts';

// The whole path, end to end: argv → discovery → bundle → browser → TAP. Nothing below can pass
// unless a URL survives every stage as the URL it is, which is the one thing unit tests of the
// pieces cannot show.

const CART = `
import { module, test } from 'qunitx';
import { total } from './helpers.js';

module('Cart', () => {
  test('adds up', (assert) => assert.equal(total([1, 2]), 3));
});
`;

const HELPERS = `
export function total(numbers) {
  return numbers.reduce((sum, each) => sum + each, 0);
}
`;

const USER = `
import { module, test } from 'qunitx';

const who: string = 'Ada';
module('User', () => {
  test('is named', (assert) => assert.equal(who, 'Ada'));
});
`;

const SUITE = {
  '/tests/cart-test.js': CART,
  '/tests/helpers.js': HELPERS,
  '/tests/README.md': '# not a test',
  '/tests/deep/user-test.ts': USER,
};

module('Inputs | a URL', { concurrency: true }, () => {
  test('one named URL runs, and brings its relative import with it', async (assert) => {
    await using server = await staticServer({ files: SUITE });
    const result = await run(`${server.url}/tests/cart-test.js`);

    assert.exitCode(result, 0);
    assert.includes(result, 'ok 1 Cart | adds up');
    // `./helpers.js` resolved against the SERVER. Resolved against the disk it would not exist,
    // and the build would have failed instead.
    assert.includes(result, '# pass 1');
  });

  test('a remote test imports the runtime that is running it', async (assert) => {
    await using server = await staticServer({ files: SUITE });
    await run(`${server.url}/tests/cart-test.js`);

    // Two files fetched, not three: `qunitx` came from node_modules, not from a server that has
    // never heard of it.
    assert.deepEqual(server.requests, ['/tests/cart-test.js', '/tests/helpers.js']);
  });

  test('a URL glob expands against the server’s own listing', async (assert) => {
    await using server = await staticServer({ files: SUITE });
    const result = await run(`'${server.url}/tests/*-test.js'`);

    assert.exitCode(result, 0);
    assert.includes(result, 'ok 1 Cart | adds up');
    assert.includes(result, '# pass 1', 'the .md and the helper are not test files');
  });

  test('`**` reaches the whole tree, and TypeScript is compiled on the way', async (assert) => {
    await using server = await staticServer({ files: SUITE });
    const result = await run(`'${server.url}/tests/**/*-test.{js,ts}'`);

    assert.exitCode(result, 0);
    assert.includes(result, '# pass 2');
    assert.includes(result, 'User | is named', 'the .ts file ran with its annotation stripped');
  });

  test('a directory URL walks it, exactly as a directory path does', async (assert) => {
    await using server = await staticServer({ files: SUITE });
    const result = await run(`${server.url}/tests/`);

    assert.exitCode(result, 0);
    assert.includes(result, '# pass 2');
  });

  test('a directory URL without its slash is still a directory', async (assert) => {
    await using server = await staticServer({ files: SUITE });
    const result = await run(`${server.url}/tests`);

    assert.exitCode(result, 0);
    assert.includes(result, '# pass 2');
  });

  test('a URL and a local path run together in one suite', async (assert) => {
    await using server = await staticServer({ files: SUITE });
    const result = await run(`${server.url}/tests/cart-test.js test/fixtures/repl-helpers.ts`);

    assert.exitCode(result, 0);
    assert.includes(result, 'Cart | adds up');
  });

  test('a failing remote test fails the run, and reports as any other would', async (assert) => {
    await using server = await staticServer({
      files: {
        '/a-test.js':
          "import { test } from 'qunitx';\ntest('breaks', (a) => a.equal(1, 2, 'nope'));\n",
      },
    });
    const result = await failingRun(`${server.url}/a-test.js`);

    assert.exitCode(result, 1);
    assert.includes(result, 'not ok 1 breaks');
    assert.includes(result, 'nope', 'with the assertion diagnostics a local failure prints');
  });

  test('a URL that is not there names itself and the status', async (assert) => {
    await using server = await staticServer({ files: SUITE });
    const result = await failingRun(`${server.url}/tests/missing.js`);

    assert.exitCode(result, 1);
    // On stderr, where every build failure this runner reports already goes.
    assert.includes(result.stderr, '/tests/missing.js');
    assert.includes(result.stderr, '404');
  });

  test('a refused host says so rather than reporting `fetch failed`', async (assert) => {
    const closed = await staticServer({ files: {} });
    const url = closed.url;
    await closed[Symbol.asyncDispose]();
    const result = await failingRun(`${url}/a-test.js`);

    assert.exitCode(result, 1);
    assert.includes(result.stderr, 'connection refused');
    // `fetch` calls all of these `fetch failed`; unwrapping the cause is what makes the line
    // worth printing at all.
    assert.notIncludes(result.stderr, 'fetch failed');
  });

  test('a glob that matches nothing runs nothing, as a local one does', async (assert) => {
    await using server = await staticServer({ files: SUITE });
    const result = await run(`'${server.url}/tests/*-nope.js'`);

    assert.includes(result, 'Running 0 test files');
  });

  test('`qunitx run` takes one too — the script is fetched and runs in the page', async (assert) => {
    await using server = await staticServer({
      files: {
        '/scripts/seed.js':
          "document.title = 'set by a remote script';\nconsole.log('seeded', document.title);\n",
      },
    });
    const result = await run(`run ${server.url}/scripts/seed.js`);

    assert.exitCode(result, 0);
    assert.includes(result, 'seeded set by a remote script', 'its own console output, as a script');
  });

  test('--search reads a remote file’s declarations without running them', async (assert) => {
    await using server = await staticServer({ files: SUITE });
    const result = await run(`${server.url}/tests/cart-test.js --search`);

    assert.exitCode(result, 0);
    // The scan fetches the source the same way the bundle does, so a URL is listable.
    assert.includes(result, 'adds up');
    // And the location it prints is the URL, which is the whole point of printing one: it is
    // meant to be pasted back as a line target. `path.relative` collapsed the `//` into `/`,
    // and `http:/127.0.0.1:…` names nothing at all.
    assert.includes(result, `${server.url}/tests/cart-test.js#`);
    assert.notIncludes(result, server.url.replace('http://', 'http:/'));
  });
});

/**
 * One `qunitx` run over `inputs`, with the output directory the helper always adds.
 *
 * Deliberately NOT pinned to an engine. Fetching an input and bundling it happens in Node, before
 * a browser is involved at all, so this belongs in the compat matrix that runs every engine —
 * which is also what `test/setup/ci-workflow-test.ts` enforces about this directory.
 */
function run(inputs: string) {
  return execute(`node cli.ts ${inputs}`);
}

/** The same, for the runs that are SUPPOSED to exit non-zero — a 404, a refusal, a red test. */
function failingRun(inputs: string) {
  return shellFails(`node cli.ts ${inputs}`);
}
