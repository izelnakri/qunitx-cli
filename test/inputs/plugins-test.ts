import { module, test } from 'qunitx';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import '../helpers/custom-asserts.ts';
import { execute as shell } from '../helpers/shell.ts';

const PROJECT_ROOT = process.cwd();
const FIXTURE_DIR = path.join(PROJECT_ROOT, 'test/fixtures/plugins-fixture');
const CLI_PATH = path.join(PROJECT_ROOT, 'cli.ts');

// Self-contained e2e: the fixture is a tiny separate project (its own package.json with
// `qunitx.plugins`) so spawning the CLI with cwd at the fixture exercises the full path —
// findProjectRoot() picks the fixture's package.json, resolvePlugins() dynamic-imports the
// local plugin file, and the resulting esbuild plugin produces a virtual module that the
// test file imports. A single Chrome instance covers the whole feature.
module('Inputs | package.json plugins', { concurrency: true }, () => {
  test('qunitx.plugins specifier is dynamic-imported and applied to the bundle', async (assert) => {
    // An explicit absolute --output, rather than the relative one the harness would add:
    // cwd is the checked-in fixture, and artifacts belong in qunitx-cli/tmp/ where the
    // runner sweeps them, not under a tracked directory.
    const output = path.join(PROJECT_ROOT, 'tmp', `plugin-fixture-${randomUUID()}`);
    const result = await shell(`node ${CLI_PATH} plugin-tests.ts --output=${output}`, {
      cwd: FIXTURE_DIR,
    });

    assert.includes(result, 'TAP version 13');
    assert.tapResult(result, { testCount: 1 });
    assert.regex(
      result.stdout,
      /ok \d+ package\.json plugins \| virtual module produced by a factory plugin loads and respects its options # \(\d+ ms\)/,
    );
  });
});
