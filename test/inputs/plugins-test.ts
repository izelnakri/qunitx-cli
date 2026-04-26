import { module, test } from 'qunitx';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';

const PROJECT_ROOT = process.cwd();
const FIXTURE_DIR = path.join(PROJECT_ROOT, 'test/fixtures/plugins-fixture');
const CLI_PATH = path.join(PROJECT_ROOT, 'cli.ts');

// Self-contained e2e: the fixture is a tiny separate project (its own package.json with
// `qunitx.plugins`) so spawning the CLI with cwd at the fixture exercises the full path —
// findProjectRoot() picks the fixture's package.json, resolvePlugins() dynamic-imports the
// local plugin file, and the resulting esbuild plugin produces a virtual module that the
// test file imports. A single Chrome instance covers the whole feature.
module('package.json plugins | end-to-end', { concurrency: true }, () => {
  test('qunitx.plugins specifier is dynamic-imported and applied to the bundle', async (assert) => {
    const permit = await acquireBrowser();
    try {
      const { stdout } = await runFixtureCli('plugin-tests.ts');
      assert.includes(stdout, 'TAP version 13');
      assert.tapResult(stdout, { testCount: 1 });
      assert.regex(
        stdout,
        /ok \d+ package\.json plugins \| virtual module produced by a factory plugin loads and respects its options # \(\d+ ms\)/,
      );
    } finally {
      permit.release();
    }
  });
});

function runFixtureCli(testFile: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // --output writes to qunitx-cli/tmp/ (not the fixture's own dir) so it gets swept by
    // test/runner.ts at the start of each suite run. Avoids leaking artifacts under the
    // checked-in fixture directory.
    const outputDir = path.join(PROJECT_ROOT, 'tmp', `plugin-fixture-${randomUUID()}`);
    const child = spawn(process.execPath, [CLI_PATH, testFile, `--output=${outputDir}`], {
      cwd: FIXTURE_DIR,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve({ stdout, stderr })
        : reject(new Error(`cli exited with ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)),
    );
  });
}
