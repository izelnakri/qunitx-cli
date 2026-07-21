import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
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

// Adoption guard for the Windows teardown-flake CLASS, not just one file. Two CI jobs have died
// to it so far — 88257274292 (custom-html) and 88774456721 (standalone-runtime): a test that
// spawns the CLI leaves esbuild-service and browser grandchildren holding handles on its temp
// dir, so on Windows a bare recursive `fs.rm` in teardown races the kernel releasing those
// handles and throws EBUSY/EPERM/ENOTEMPTY. rmRetry() absorbs that race. A spawn-based test
// cannot close those handles itself (they belong to grandchildren), so retrying the removal is
// the only fix — unlike in-process bundler/watcher tests, which own and close their handles.
// This guard fails the moment a spawn-based test reintroduces a non-retrying recursive removal,
// so the class stays fixed instead of resurfacing one Windows job at a time.
const SPAWNS_CLI = /spawnCapture|helpers\/shell|node:child_process|runInDir/;
const BARE_RECURSIVE_RM = /(?:fs\.)?\brm\([^;]*?recursive:\s*true/;

async function testFilesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return testFilesUnder(full);
      return Promise.resolve(full.endsWith('-test.ts') ? [full] : []);
    }),
  );
  return nested.flat();
}

module('Helpers | rmRetry adoption', { concurrency: true }, () => {
  test('spawn-based tests use rmRetry() for temp-dir teardown, never a bare recursive fs.rm', async (assert) => {
    const testRoot = path.join(process.cwd(), 'test');
    const files = await testFilesUnder(testRoot);
    assert.ok(files.length > 50, 'the walk actually traversed the test tree');

    const offenders: string[] = [];
    for (const file of files) {
      // Skip this guard and the helper: both carry the patterns above as regex-literal text.
      if (/rm-retry(-test)?\.ts$/.test(file)) continue;
      const src = await fs.readFile(file, 'utf8');
      if (SPAWNS_CLI.test(src) && BARE_RECURSIVE_RM.test(src)) {
        offenders.push(path.relative(testRoot, file));
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `spawn-based tests must use rmRetry() for teardown (Windows EBUSY flake): ${offenders.join(', ')}`,
    );
  });
});
