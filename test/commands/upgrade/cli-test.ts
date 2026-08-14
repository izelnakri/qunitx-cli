import { module, test } from 'qunitx';
import process from 'node:process';
import { spawnCapture } from '../../helpers/shell.ts';
import '../../helpers/custom-asserts.ts';

// cli.ts's dispatch of `upgrade`, asserted through the real binary. Only the two paths that are
// the same on every install are exercised here — usage and a bad argument — because the CLI under
// test is a source checkout in one CI lane and a compiled binary in the other, and neither of
// these two touches the network. The per-channel behaviour is unit-tested in run-test.ts.

const cli = (args: string): ReturnType<typeof spawnCapture> =>
  spawnCapture(`node cli.ts upgrade ${args}`, { env: { ...process.env, FORCE_COLOR: '0' } });

module('Commands | Upgrade | cli', { concurrency: true }, () => {
  test('`qunitx upgrade --help` documents the per-channel behaviour and exits 0', async (assert) => {
    const result = await cli('--help');

    assert.strictEqual(result.code, 0);
    assert.includes(result.stdout, 'Usage: qunitx upgrade');
    assert.includes(result.stdout, 'What it does per install:');
    assert.includes(result.stdout, '--check');
  });

  test('an unrecognised argument fails with the usage text rather than a stack', async (assert) => {
    const result = await cli('--dry-run').catch(
      (error: unknown) => error as { code: number; stderr: string },
    );

    assert.strictEqual(result.code, 2, 'exit 2 is "could not run", distinct from "you are stale"');
    assert.includes(result.stderr, 'Unknown qunitx upgrade argument: --dry-run');
    assert.includes(result.stderr, 'Usage: qunitx upgrade');
  });
});
