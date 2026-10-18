import { module, test } from 'qunitx';
import { shellSettles } from '../helpers/shell.ts';
import '../helpers/custom-asserts.ts';

// A reader that has gone — `qunitx … | head`, a terminal that was closed — has nothing left to be
// told, and is no verdict on the tests. Every write to it used to raise an unhandled EPIPE that
// exited 1: a passing suite reported as failed, and under a deno-compiled binary that error landed
// ahead of a signal already stopping the process, so `--watch` sent SIGHUP exited 1, not 129.
module('Commands | a reader that has gone', { concurrency: true }, () => {
  test('a passing run still exits 0', async (assert) => {
    const result = await shellSettles('node cli.ts test/fixtures/passing-tests.ts', {
      closeStdout: true,
    });

    assert.exitCode(result, 0);
    assert.notIncludes(result.stderr, 'EPIPE');
  });

  test('a failing run still exits 1 — the write is dropped, not the verdict', async (assert) => {
    const result = await shellSettles('node cli.ts test/fixtures/failing-tests.ts', {
      closeStdout: true,
    });

    assert.exitCode(result, 1);
    assert.notIncludes(result.stderr, 'EPIPE');
  });
});
