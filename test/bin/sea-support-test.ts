import { module, test } from 'qunitx';
import { canUseSea, SEA_EXTERNALS } from '../../bin/sea-support.js';
import { tempDir } from '../helpers/temp-dir.ts';
import fs from 'node:fs/promises';
import path from 'node:path';

// The npm bin entry hands off to a pre-built SEA binary when one is installed. That binary has no
// module path, so the bundle's bare imports resolve against the CWD — this predicate is the whole
// of the decision, and 0.34.0 shipped without it: every globally-installed run in a project with
// no node_modules died on `Cannot find package 'playwright-core' imported from <cwd>`.
module('Bin | canUseSea', { concurrency: true }, () => {
  test('a project with no node_modules cannot host the SEA', async (assert) => {
    await using dir = await tempDir('sea-bare');

    assert.false(canUseSea(dir.path), 'so the bin entry falls back to dist/cli.js');
  });

  test('this repository can, since it has the externals installed', (assert) => {
    assert.true(canUseSea(process.cwd()), 'the SEA fast path stays available where it works');
  });

  test('every external is required, not just the first', async (assert) => {
    // Spelled out rather than read from SEA_EXTERNALS: a test that iterates the list under test
    // shrinks with it, so dropping `ws` from the guard would silently drop its own coverage.
    const REQUIRED = ['playwright-core', 'esbuild', 'ws'];
    assert.deepEqual([...SEA_EXTERNALS].sort(), [...REQUIRED].sort(), 'the bundle externals');

    // A project carrying SOME of them is the dangerous middle case: checking only playwright-core
    // would green-light a SEA that then dies on esbuild instead.
    for (const missing of REQUIRED) {
      await using dir = await tempDir('sea-partial');
      for (const name of REQUIRED) {
        if (name === missing) continue;
        const packageDir = path.join(dir.path, 'node_modules', name);
        await fs.mkdir(packageDir, { recursive: true });
        await fs.writeFile(path.join(packageDir, 'index.js'), '');
        await fs.writeFile(
          path.join(packageDir, 'package.json'),
          JSON.stringify({ name, version: '1.0.0', main: 'index.js' }),
        );
      }

      assert.false(canUseSea(dir.path), `${missing} missing is enough to refuse the SEA`);
    }
  });
});
