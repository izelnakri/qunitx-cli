import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { module, test } from 'qunitx';
import { writeOutputStaticFiles } from '../../lib/setup/write-output-static-files.ts';
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

async function writeAsset(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}
