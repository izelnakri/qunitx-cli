import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import '../helpers/custom-asserts.ts';

// Guards against "bumped the qunitx devDependency but forgot `make vendor`": the embedded runtime
// + stylesheet under templates/vendor/ must stay pinned to the installed qunitx version, since
// they are what consumers actually run (they never install qunitx themselves).
const repoRoot = process.cwd();
const require = createRequire(path.join(repoRoot, 'package.json'));

module('Setup | vendored qunitx runtime freshness', { concurrency: true }, () => {
  test('templates/vendor is regenerated for the installed qunitx (run `make vendor` after bumping)', async (assert) => {
    const entry = require.resolve('qunitx');
    const rootMatch = /^(.*[\\/]qunitx)[\\/]/.exec(entry);
    assert.ok(rootMatch, `derives the installed qunitx root from ${entry}`);
    const qunitxRoot = rootMatch![1];
    const installedVersion = JSON.parse(
      await fs.readFile(path.join(qunitxRoot, 'package.json'), 'utf8'),
    ).version;

    const pinned = (
      await fs.readFile(path.join(repoRoot, 'templates/vendor/.qunitx-version'), 'utf8')
    ).trim();
    assert.equal(
      pinned,
      installedVersion,
      'vendored runtime is pinned to the installed qunitx — run `make vendor` and commit',
    );

    // Compare content, not line endings: git's autocrlf checks the committed copy out with CRLF on
    // Windows while the node_modules copy stays LF, so a raw byte compare would false-fail there.
    const normalize = (s: string) => s.replace(/\r\n/g, '\n');
    const committedCss = normalize(
      await fs.readFile(path.join(repoRoot, 'templates/vendor/qunit.css'), 'utf8'),
    );
    const sourceCss = normalize(
      await fs.readFile(path.join(qunitxRoot, 'vendor/qunit.css'), 'utf8'),
    );
    assert.equal(committedCss, sourceCss, 'committed qunit.css matches the installed qunitx copy');

    const runtime = await fs.readFile(
      path.join(repoRoot, 'templates/vendor/qunitx-runtime.js'),
      'utf8',
    );
    assert.ok(runtime.length > 50_000, 'vendored runtime is a non-trivial bundle');
    assert.includes(runtime, 'QUnit', 'vendored runtime inlines QUnit');
  });
});
