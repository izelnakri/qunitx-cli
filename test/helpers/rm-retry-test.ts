import { module, test } from 'qunitx';
import { rmRetry } from './rm-retry.ts';

// Regression coverage for the Windows teardown flake in test/inputs/custom-html-test.ts
// (CI job 88257274292): a watch-mode child's fs.watch handles outlive the kill, so removing
// the project directory fails while the kernel still holds them. The retry ladder only caught
// EBUSY, but Windows reports the same condition as EPERM and ENOTEMPTY — those aborted cleanup
// on the first attempt instead of waiting for the handles to drop.

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

/** Fails with `code` for the first `failures` calls, then succeeds. Records the sleeps taken. */
function flakyRm(code: string, failures: number) {
  const sleeps: number[] = [];
  let calls = 0;
  return {
    sleeps,
    get calls() {
      return calls;
    },
    rm: () => {
      calls++;
      return calls <= failures ? Promise.reject(errno(code)) : Promise.resolve();
    },
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

module('Helpers | rmRetry', { concurrency: true }, () => {
  for (const code of ['EBUSY', 'EPERM', 'ENOTEMPTY']) {
    test(`retries a lingering-handle ${code} until the handle drops`, async (assert) => {
      const stub = flakyRm(code, 2);

      await rmRetry('/tmp/project', { rm: stub.rm, sleep: stub.sleep });

      assert.equal(stub.calls, 3, 'retried past both failures and then succeeded');
      assert.deepEqual(stub.sleeps, [300, 600], 'backs off further on each attempt');
    });
  }

  test('succeeds without sleeping when the directory is free', async (assert) => {
    const stub = flakyRm('EBUSY', 0);

    await rmRetry('/tmp/project', { rm: stub.rm, sleep: stub.sleep });

    assert.equal(stub.calls, 1, 'one call');
    assert.deepEqual(stub.sleeps, [], 'a clean removal pays no retry delay');
  });

  test('rethrows an unrelated error immediately', async (assert) => {
    const stub = flakyRm('EACCES', 1);

    await assert.rejects(
      rmRetry('/tmp/project', { rm: stub.rm, sleep: stub.sleep }),
      'a permissions error is a real failure, not a lingering handle',
    );
    assert.equal(stub.calls, 1, 'no retry for a non-handle error');
  });

  test('gives up after the attempt cap rather than looping forever', async (assert) => {
    const stub = flakyRm('EBUSY', Infinity);

    await assert.rejects(
      rmRetry('/tmp/project', { attempts: 3, rm: stub.rm, sleep: stub.sleep }),
      'surfaces the error once the ladder is exhausted',
    );
    assert.equal(stub.calls, 3, 'stopped at the attempt cap');
  });
});
