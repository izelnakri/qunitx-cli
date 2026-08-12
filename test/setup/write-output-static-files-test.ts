import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { module, test } from 'qunitx';
import { writeOutputStaticFiles } from '../../lib/setup/write-output-static-files.ts';
import { pathExists } from '../../lib/utils/path-exists.ts';
import type { HtmlAssets } from '../../lib/types.ts';

// The two collections writeOutputStaticFiles iterates over; the rest of HtmlAssets is
// resolved HTML this function never reads.
function htmlAssetsFor(opts: {
  staticHTMLs?: Record<string, string>;
  assets?: string[];
}): HtmlAssets {
  return {
    assets: new Set(opts.assets ?? []),
    mainHTML: { filePath: null, html: null },
    staticHTMLs: opts.staticHTMLs ?? {},
    dynamicContentHTMLs: {},
  };
}

async function tempDir(prefix: string): Promise<string> {
  const dir = path.join(process.cwd(), 'tmp', `${prefix}-${crypto.randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

module('Setup | writeOutputStaticFiles', { concurrency: true }, () => {
  test('asset under projectRoot lands at outDir/<rel>', async (assert) => {
    const projectRoot = await tempDir('wsf');
    const asset = path.join(projectRoot, 'node_modules', 'qunitx', 'vendor', 'qunit.css');
    await writeAsset(asset, '/* css */');

    await writeOutputStaticFiles(
      { projectRoot, output: 'tmp/out' },
      htmlAssetsFor({ assets: [asset] }),
    );

    const dest = path.join(
      projectRoot,
      'tmp',
      'out',
      'node_modules',
      'qunitx',
      'vendor',
      'qunit.css',
    );
    assert.strictEqual(
      await fs.readFile(dest, 'utf8'),
      '/* css */',
      'asset copied under outDir at the same relative subpath',
    );
  });

  test('asset OUTSIDE projectRoot still lands inside outDir (no `..` escape)', async (assert) => {
    // Mirrors the pnpm/yarn-workspace and test-fixture-symlink case: qunitx is
    // hoisted to a parent's node_modules, so its absolute realpath resolves to
    // a tree outside `projectRoot`. Without stripping the leading `..` from the
    // computed relative path, `path.join(outDir, '..\\..\\node_modules\\…')`
    // would cancel two segments of outDir and converge multiple group runs on
    // the same destination — root cause of the Windows EBUSY observed in CI.
    const workspace = await tempDir('wsf-ws');
    const projectRoot = path.join(workspace, 'packages', 'foo');
    const asset = path.join(workspace, 'node_modules', 'qunitx', 'vendor', 'qunit.css');
    await Promise.all([
      fs.mkdir(projectRoot, { recursive: true }),
      writeAsset(asset, '/* hoisted css */'),
    ]);

    await writeOutputStaticFiles(
      { projectRoot, output: 'tmp/run-X/group-0' },
      htmlAssetsFor({ assets: [asset] }),
    );

    const dest = path.join(projectRoot, 'tmp/run-X/group-0/node_modules/qunitx/vendor/qunit.css');
    const escapePath = path.join(projectRoot, 'tmp/node_modules/qunitx/vendor/qunit.css');
    const [destContent, escapeExists] = await Promise.all([
      fs.readFile(dest, 'utf8'),
      fs
        .stat(escapePath)
        .then(() => true)
        .catch(() => false),
    ]);
    assert.strictEqual(destContent, '/* hoisted css */', 'asset anchored at outDir');
    assert.equal(escapeExists, false, 'nothing written at the escaped path');
  });

  test('two outputs sharing one source land at distinct dests (group-mode shape)', async (assert) => {
    // Concrete shape of what run.ts does in concurrent group mode: each group
    // gets its own outDir like `tmp/run-X/group-0`, `tmp/run-X/group-1`. Both
    // copy the same upstream asset; their dests must differ for parallel
    // copyFile to be safe under Windows file locking.
    const workspace = await tempDir('wsf-groups');
    const projectRoot = path.join(workspace, 'packages', 'foo');
    const asset = path.join(workspace, 'node_modules', 'qunitx', 'vendor', 'qunit.css');
    await Promise.all([
      fs.mkdir(projectRoot, { recursive: true }),
      writeAsset(asset, '/* shared */'),
    ]);

    await Promise.all([
      writeOutputStaticFiles(
        { projectRoot, output: 'tmp/run-X/group-0' },
        htmlAssetsFor({ assets: [asset] }),
      ),
      writeOutputStaticFiles(
        { projectRoot, output: 'tmp/run-X/group-1' },
        htmlAssetsFor({ assets: [asset] }),
      ),
    ]);

    const a = path.join(projectRoot, 'tmp/run-X/group-0/node_modules/qunitx/vendor/qunit.css');
    const b = path.join(projectRoot, 'tmp/run-X/group-1/node_modules/qunitx/vendor/qunit.css');
    const [contentA, contentB] = await Promise.all([
      fs.readFile(a, 'utf8'),
      fs.readFile(b, 'utf8'),
    ]);
    assert.strictEqual(contentA, '/* shared */');
    assert.strictEqual(contentB, '/* shared */');
  });
});

// A globally-installed CLI running in a project that never installed `qunitx` has no
// `node_modules/qunitx/vendor/qunit.css` — but `qunitx init` writes a page that links it. Copying
// it blindly used to abort the whole run with ENOENT before a single test could report.
module('Setup | writeOutputStaticFiles | missing assets', { concurrency: true }, () => {
  test('a missing qunit.css falls back to the CLI copy, as the server already does', async (assert) => {
    const dir = await tempDir('assets-no-qunitx');
    const missing = path.join(dir, 'node_modules/qunitx/vendor/qunit.css');

    await writeOutputStaticFiles(
      { projectRoot: dir, output: 'out' },
      htmlAssetsFor({ assets: [missing] }),
    );

    const written = await fs.readFile(
      path.join(dir, 'out/node_modules/qunitx/vendor/qunit.css'),
      'utf8',
    );
    assert.true(written.length > 0, 'the embedded stylesheet was written instead');
    assert.true(written.includes('#qunit'), 'and it really is qunit.css, not an empty placeholder');
  });

  test('any other missing asset is skipped rather than failing the run', async (assert) => {
    const dir = await tempDir('assets-missing');
    const missing = path.join(dir, 'app.css');

    await writeOutputStaticFiles(
      { projectRoot: dir, output: 'out' },
      htmlAssetsFor({ assets: [missing] }),
    );

    assert.false(
      await pathExists(path.join(dir, 'out/app.css')),
      'nothing invented for an asset the page names but the project does not have',
    );
  });

  test('a real asset alongside a missing one is still copied', async (assert) => {
    const dir = await tempDir('assets-mixed');
    const real = path.join(dir, 'real.css');
    await writeAsset(real, '/* real */');

    await writeOutputStaticFiles(
      { projectRoot: dir, output: 'out' },
      htmlAssetsFor({ assets: [real, path.join(dir, 'gone.css')] }),
    );

    assert.strictEqual(await fs.readFile(path.join(dir, 'out/real.css'), 'utf8'), '/* real */');
  });
});

async function writeAsset(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}
