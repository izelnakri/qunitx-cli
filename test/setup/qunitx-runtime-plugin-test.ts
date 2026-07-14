import { module, test } from 'qunitx';
import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { qunitxRuntimePlugin } from '../../lib/setup/qunitx-runtime-plugin.ts';
import '../helpers/custom-asserts.ts';

// Bundle `export * from 'qunitx'` with the plugin, resolving from `resolveDir`. The recursion
// guard is exercised implicitly: without it, build.resolve re-entering onResolve would loop and
// this build would never settle.
async function bundleFrom(resolveDir: string): Promise<string> {
  const result = await esbuild.build({
    stdin: { contents: `export * from 'qunitx';\n`, resolveDir },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    plugins: [qunitxRuntimePlugin()],
  });
  return result.outputFiles[0].text;
}

module('Setup | qunitxRuntimePlugin', { concurrency: true }, () => {
  test('falls back to the embedded runtime when qunitx is not installed', async (assert) => {
    // Temp dir with no node_modules/qunitx on its ancestry — build.resolve fails, so the plugin
    // serves the embedded vendored runtime instead of erroring.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qxplugin-none-'));
    try {
      const out = await bundleFrom(dir);
      assert.includes(out, 'QUnit', 'embedded QUnit runtime is inlined into the bundle');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('honors a consumer-installed qunitx over the embedded runtime', async (assert) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qxplugin-real-'));
    try {
      const pkgDir = path.join(dir, 'node_modules/qunitx');
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'qunitx', version: '9.9.9', type: 'module', exports: './index.js' }),
      );
      await fs.writeFile(
        path.join(pkgDir, 'index.js'),
        `export const module = 'FAKE_MODULE_MARKER';\nexport const test = 'FAKE_TEST_MARKER';\n`,
      );
      const out = await bundleFrom(dir);
      assert.includes(out, 'FAKE_TEST_MARKER', 'the consumer-installed qunitx is used');
      assert.notIncludes(
        out,
        'QUnit',
        'the embedded runtime is not inlined when a real one resolves',
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
