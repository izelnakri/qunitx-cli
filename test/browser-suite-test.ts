import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { module, test } from 'qunitx';
import { execute } from './helpers/shell.ts';
import { staticServer } from './helpers/static-server.ts';
import './helpers/custom-asserts.ts';

// `test/browser-suite.ts` is the part of this project's own suite that runs in a browser, and CI
// publishes the page a run leaves behind to GitHub Pages. So it is covered twice here: the page
// has to be green, and the copy has to still work once the server that produced it is gone —
// which is the only thing standing between a green CI run and a broken link in the README.

const ENTRY = 'test/browser-suite.ts';
const VENDOR_CSS = 'node_modules/qunitx/vendor/qunit.css';
// One per area the page covers, so a file dropped from the entry shows up as a missing area
// rather than as a count that quietly got smaller.
const AREAS = [
  'Result |',
  'Stream |',
  'Selection |',
  'Utils |',
  'Reporters |',
  'API |',
  'Setup |',
  'Daemon |',
];

module('Browser suite', { concurrency: true }, () => {
  test('every file it collects is one a browser can run', async (assert) => {
    const entry = await fs.readFile(ENTRY, 'utf8');
    const imports = Array.from(entry.matchAll(/^import '(\.[^']+)';$/gm), (match) => match[1]);

    assert.true(imports.length > 5, `${ENTRY} collects ${imports.length} files`);

    for (const specifier of imports) {
      const file = path.join(path.dirname(ENTRY), specifier);
      const source = await fs.readFile(file, 'utf8').catch(() => null);

      assert.ok(source, `${specifier} exists`);
      // The membership rule, enforced where it is cheap to enforce: a `node:` import fails the
      // bundle, and a `process` or `Deno` reference fails in the page — either way the failure
      // would first be seen by whoever is deploying, not by whoever added the file.
      assert.notOk(/from 'node:|\bprocess\.|\bDeno\./.test(source ?? ''), `${specifier} is pure`);
    }
  });

  test('the page it leaves behind runs the same suite from a URL, with no server behind it', async (assert) => {
    const output = path.join('tmp', `browser-suite-${randomUUID()}`);
    const built = await execute(`node cli.ts ${ENTRY} --output=${output}`);

    assert.exitCode(built, 0);
    AREAS.forEach((area) => assert.includes(built, area, `${area} tests ran in the browser`));
    assert.includes(built, '# fail 0');

    // What CI uploads: one page, one bundle, one stylesheet — no reference to anything that
    // only exists on the machine that built it.
    const [html, bundle, css] = await Promise.all([
      fs.readFile(path.join(output, 'index.html'), 'utf8'),
      fs.readFile(path.join(output, 'tests.js'), 'utf8'),
      fs.readFile(path.join(output, ...VENDOR_CSS.split('/')), 'utf8'),
    ]);

    assert.includes(html, `./${VENDOR_CSS}`, 'the page links the stylesheet next to it');
    assert.includes(css, '#qunit-tests', 'which is QUnit’s own');
    assert.notIncludes(html, process.cwd(), 'nothing in the page points at this machine');

    // A plain file server — no WebSocket, so the page that waits for one would never start.
    await using published = await staticServer({
      files: { '/index.html': html, '/tests.js': bundle, [`/${VENDOR_CSS}`]: css },
    });
    const remote = await execute(`node cli.ts ${published.url}/`);

    assert.exitCode(remote, 0);
    assert.includes(remote, '# fail 0');
    assert.equal(
      totalOf(remote.stdout),
      totalOf(built.stdout),
      'the published page runs every test the local run did',
    );
  });
});

/** The TAP summary's test count, which is how the two runs are compared. */
function totalOf(output: string): number {
  return Number(output.match(/^# tests (\d+)$/m)?.[1] ?? -1);
}
