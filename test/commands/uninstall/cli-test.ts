import { module, test } from 'qunitx';
import process from 'node:process';
import { spawnCapture } from '../../helpers/shell.ts';
import '../../helpers/custom-asserts.ts';

// cli.ts's dispatch of `uninstall`, through the real binary. Only the paths that are the same on
// every install are exercised here — the usage, a bad argument, and the refusal every contributor
// meets, since the CLI under test is itself a source checkout. Per-channel behaviour is unit
// tested in index-test.ts, where the filesystem is injected rather than deleted.

const cli = (args: string): ReturnType<typeof spawnCapture> =>
  spawnCapture(`node cli.ts uninstall ${args}`.trim(), {
    env: { ...process.env, FORCE_COLOR: '0' },
  });

module('Commands | Uninstall | cli', { concurrency: true }, () => {
  test('`qunitx uninstall --help` documents the per-channel behaviour and exits 0', async (assert) => {
    const result = await cli('--help');

    assert.strictEqual(result.code, 0);
    assert.includes(result.stdout, 'Usage: qunitx uninstall');
    assert.includes(result.stdout, 'What it does per install:');
    assert.includes(result.stdout, '--dry-run');
  });

  test('from a source checkout it refuses, and says who owns the files', async (assert) => {
    const result = await cli('').catch(
      (error: unknown) => error as { code: number; stdout: string },
    );

    assert.strictEqual(result.code, 1, 'exit 1 is "removed another way", not a failure to run');
    assert.includes(result.stdout, 'source checkout');
    assert.includes(result.stdout, 'git');
  });

  test('an unrecognised argument fails with the usage rather than a stack', async (assert) => {
    const result = await cli('--yolo').catch(
      (error: unknown) => error as { code: number; stderr: string },
    );

    assert.strictEqual(result.code, 2);
    assert.includes(result.stderr, 'Unknown qunitx uninstall argument: --yolo');
    assert.includes(result.stderr, 'Usage: qunitx uninstall');
  });
});
