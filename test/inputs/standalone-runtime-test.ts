import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { rmRetry } from '../helpers/rm-retry.ts';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnCapture } from '../helpers/shell.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import '../helpers/custom-asserts.ts';

const CLI = path.join(process.cwd(), 'cli.ts');
const QUNITX_BROWSER = process.env.QUNITX_BROWSER;
const require = createRequire(path.join(process.cwd(), 'package.json'));

function runInDir(dir: string, testFile: string): Promise<{ stdout: string; stderr: string }> {
  const browserFlag = QUNITX_BROWSER ? ` --browser=${QUNITX_BROWSER}` : '';
  return spawnCapture(`node ${CLI} ${testFile} --output=${path.join(dir, 'out')}${browserFlag}`, {
    cwd: dir,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
}

module('Inputs | qunitx runtime resolution', { concurrency: true }, () => {
  test('falls back to the CLI-provided runtime when the project never installed qunitx', async (assert) => {
    // The temp project lives under os.tmpdir(), OUTSIDE the repo's node_modules ancestry, so the
    // CLI's ANCESTOR_NODE_MODULES (computed from its cwd) finds no qunitx — forcing the esbuild
    // runtime plugin's embedded fallback and the CLI-served qunit.css. Reproduces the fresh
    // JSR/standalone-binary install path.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qunitx-standalone-'));
    const permit = await acquireBrowser();
    try {
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'standalone-probe', version: '1.0.0', type: 'module' }),
      );
      await fs.writeFile(
        path.join(dir, 'my-test.js'),
        `import { module, test } from 'qunitx';\n` +
          `module('standalone', () => {\n` +
          `  test('runs without installing qunitx', (assert) => {\n` +
          `    assert.ok(true);\n` +
          `    assert.equal(1 + 1, 2);\n` +
          `  });\n` +
          `});\n`,
      );
      const result = await runInDir(dir, 'my-test.js');

      assert.includes(result.stdout, 'TAP version 13');
      assert.tapResult(result, { testCount: 1 });
      const output = result.stdout + result.stderr;
      assert.notIncludes(
        output,
        'ENOENT',
        'no missing-file error (qunit.css is served, not copied)',
      );
      assert.notIncludes(
        output,
        'Could not resolve',
        'the qunitx import resolves via the embedded runtime',
      );
    } finally {
      permit.release();
      await rmRetry(dir);
    }
  });

  test('a project-installed qunitx takes precedence over the CLI-provided runtime', async (assert) => {
    // Copy the real qunitx into the project's node_modules and stamp a provenance marker onto each
    // of its entry conditions. The test imports that marker and asserts it, so a green run PROVES
    // the project's copy was bundled — the embedded runtime has no such export, so if precedence
    // regressed the import would either be undefined (fail 1) or unresolvable (esbuild error).
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qunitx-consumer-'));
    const permit = await acquireBrowser();
    try {
      const rootMatch = /^(.*[\\/]qunitx)[\\/]/.exec(require.resolve('qunitx'));
      assert.ok(rootMatch, 'resolves the repo-installed qunitx to copy');
      const destQunitx = path.join(dir, 'node_modules/qunitx');
      await fs.cp(rootMatch![1], destQunitx, { recursive: true });
      for (const entry of ['browser', 'node', 'deno']) {
        await fs
          .appendFile(
            path.join(destQunitx, `dist/${entry}/index.js`),
            `\nexport const __PROVENANCE__ = 'project-node-modules';\n`,
          )
          .catch(() => {});
      }

      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'consumer-probe', version: '1.0.0', type: 'module' }),
      );
      await fs.writeFile(
        path.join(dir, 'my-test.js'),
        `import { module, test, __PROVENANCE__ } from 'qunitx';\n` +
          `module('consumer', () => {\n` +
          `  test('uses the project-installed qunitx', (assert) => {\n` +
          `    assert.equal(__PROVENANCE__, 'project-node-modules');\n` +
          `  });\n` +
          `});\n`,
      );
      const result = await runInDir(dir, 'my-test.js');

      assert.includes(result.stdout, 'TAP version 13');
      // Green run ⇒ the provenance assertion passed ⇒ the project's qunitx (not the embedded
      // runtime) was bundled. A wrong precedence would surface as fail 1 or a resolve error.
      assert.tapResult(result, { testCount: 1 });
      assert.notIncludes(result.stdout + result.stderr, 'Could not resolve');
    } finally {
      permit.release();
      await rmRetry(dir);
    }
  });
});
