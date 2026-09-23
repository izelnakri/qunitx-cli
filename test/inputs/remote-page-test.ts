import fs from 'node:fs/promises';
import { module, test } from 'qunitx';
import { execute, shellFails } from '../helpers/shell.ts';
import { staticServer } from '../helpers/static-server.ts';
import { addQUnitFilter, couldBeAPage, looksLikeQUnitPage } from '../../lib/setup/remote-page.ts';
import '../helpers/custom-asserts.ts';

// A suite that already has a page — the shape of every QUnit project on the web, and of
// `qunitx https://objectmodel.js.org/test/`. Nothing is bundled: the page is opened where it
// lives, and QUnit reports through the hook. These serve one locally and run it for real.

/** The vendored runtime is a genuine QUnit 2.x surface, so the fixture page is a genuine runner. */
const RUNTIME = await fs.readFile('templates/vendor/qunitx-runtime.js', 'utf8');

const page = (body: string) => `<!doctype html>
<html>
  <head>
    <title>QUnit — fixture</title>
    <script type="module">
      import * as QUnit from './runtime.js';
      window.QUnit = QUnit;
      ${body}
      QUnit.start();
    </script>
  </head>
  <body><div id="qunit"></div><div id="qunit-fixture"></div></body>
</html>`;

const GREEN = page(`
  QUnit.module('Cart', () => {
    QUnit.test('sums line items', (assert) => assert.equal(2 + 2, 4));
    QUnit.test('applies a coupon', (assert) => assert.equal(10 - 1, 9));
  });
  QUnit.module('User', () => {
    QUnit.test('is named', (assert) => assert.equal('Ada', 'Ada'));
  });
`);

const RED = page(`
  QUnit.module('Cart', () => {
    QUnit.test('sums line items', (assert) => assert.equal(2 + 2, 4));
    QUnit.test('overcharges', (assert) => assert.equal(2 + 2, 5, 'four is not five'));
  });
`);

module('Inputs | a remote QUnit page', { concurrency: true }, () => {
  test('its tests run and report, without anything being bundled', async (assert) => {
    await using server = await staticServer({
      files: { '/test/index.html': GREEN, '/test/runtime.js': RUNTIME },
    });
    const result = await execute(`node cli.ts ${server.url}/test/`);

    assert.exitCode(result, 0);
    assert.includes(result, 'Running 1 test file');
    assert.includes(result, 'ok 1 Cart | sums line items');
    assert.includes(result, 'ok 3 User | is named');
    assert.includes(result, '# pass 3');
  });

  test('a failing test fails the run, with its message', async (assert) => {
    await using server = await staticServer({
      files: { '/test/index.html': RED, '/test/runtime.js': RUNTIME },
    });
    const result = await shellFails(`node cli.ts ${server.url}/test/`);

    assert.exitCode(result, 1);
    assert.includes(result, 'not ok 2 Cart | overcharges');
    assert.includes(result, 'four is not five', 'the assertion’s own message survives the hop');
    assert.includes(result, '# fail 1');
  });

  test('`-t` narrows it, because QUnit reads its own filter off the URL', async (assert) => {
    await using server = await staticServer({
      files: { '/test/index.html': GREEN, '/test/runtime.js': RUNTIME },
    });
    const result = await execute(`node cli.ts ${server.url}/test/ -t 'is named'`);

    assert.includes(result, '# pass 1');
    assert.notIncludes(result, 'sums line items');
  });

  test('a page named without its slash is the same page', async (assert) => {
    await using server = await staticServer({
      files: { '/test/index.html': GREEN, '/test/runtime.js': RUNTIME },
    });
    const result = await execute(`node cli.ts ${server.url}/test`);

    assert.exitCode(result, 0);
    assert.includes(result, '# pass 3');
  });

  test('a page and a local file in one run is refused, and says why', async (assert) => {
    await using server = await staticServer({
      files: { '/test/index.html': GREEN, '/test/runtime.js': RUNTIME },
    });
    const result = await shellFails(
      `node cli.ts ${server.url}/test/ test/fixtures/passing-tests.js`,
    );

    assert.includes(result.stderr, 'is a suite of its own and runs on its own');
  });

  test('a URL that answers nothing QUnit-shaped is not treated as one', async (assert) => {
    await using server = await staticServer({
      files: { '/site/index.html': '<!doctype html><h1>a website</h1>' },
    });
    const result = await execute(`node cli.ts ${server.url}/site/`);

    // It falls back to the listing walk, which finds no test files — the behaviour a plain
    // website had before pages were understood at all.
    assert.includes(result, 'Running 0 test files');
  });
});

module('Inputs | a remote QUnit page | recognising one', { concurrency: true }, () => {
  test('a module URL is never asked about, so it is fetched once and not twice', (assert) => {
    // The fetch that answers "is this a page" is only worth spending where the answer could be
    // yes. Asking it of every remote test file doubled the requests a run made.
    assert.false(couldBeAPage('https://x/tests/cart-test.js'));
    assert.false(couldBeAPage('https://x/tests/helpers.mjs?v=2'));
    assert.true(couldBeAPage('https://x/test/'), 'a directory could be one');
    assert.true(couldBeAPage('https://x/test'), 'with or without its slash');
    assert.true(couldBeAPage('https://x/tests/index.html'));
  });

  test('the markup every QUnit runner has', (assert) => {
    assert.true(looksLikeQUnitPage('<div id="qunit-fixture"></div>'));
    assert.true(looksLikeQUnitPage('<div id="qunit"></div>'));
    assert.true(
      looksLikeQUnitPage('<script src="https://code.jquery.com/qunit/qunit-2.17.2.js"></script>'),
      'the real ObjectModel page’s own script tag',
    );
    assert.true(looksLikeQUnitPage('<script>QUnit.test("x", () => {})</script>'));
  });

  test('and what is not one', (assert) => {
    assert.false(looksLikeQUnitPage('<a href="cart-test.js">cart-test.js</a>'), 'an autoindex');
    assert.false(looksLikeQUnitPage('<!doctype html><h1>a website</h1>'));
    assert.false(looksLikeQUnitPage('["cart-test.js","helpers.js"]'), 'a JSON listing');
  });
});

module('Inputs | a remote QUnit page | the filter it is given', { concurrency: true }, () => {
  test('becomes QUnit’s own, beside whatever the URL already carried', (assert) => {
    assert.strictEqual(addQUnitFilter('https://x/test/', 'adds'), 'https://x/test/?filter=adds');
    assert.strictEqual(
      addQUnitFilter('https://x/test/?moduleId=6e15ed5f', 'adds'),
      'https://x/test/?moduleId=6e15ed5f&filter=adds',
    );
  });

  test('a filter typed into the URL wins, since it was typed', (assert) => {
    assert.strictEqual(
      addQUnitFilter('https://x/test/?filter=mine', 'adds'),
      'https://x/test/?filter=mine',
    );
  });

  test('no filter changes nothing', (assert) => {
    assert.strictEqual(addQUnitFilter('https://x/test/', undefined), 'https://x/test/');
    assert.strictEqual(addQUnitFilter('https://x/test/', ''), 'https://x/test/');
  });
});
