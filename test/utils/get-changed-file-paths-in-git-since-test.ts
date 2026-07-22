import fs from 'node:fs/promises';
import path from 'node:path';
import * as Result from '../../lib/result/index.ts';
import crypto from 'node:crypto';
import { module, test } from 'qunitx';
import {
  BLAST_RADIUS_FILES,
  BLAST_RADIUS_PATTERNS,
  getChangedFilePathsInGitSince,
  runGit,
} from '../../lib/utils/get-changed-file-paths-in-git-since.ts';

// Each test gets a private temp git repo. `git init` + 2 commits ≈ 60-90 ms.
// Tests run concurrently so wall-clock cost stays under 200 ms for the full module.
// Setup git goes through `runGit` (bounded + settle-guaranteed) — not raw execFile —
// so a git child whose exit event never lands rejects fast instead of wedging the test
// for the full 300s per-test budget (the deno/Windows flake this file previously hit).
async function makeRepo(initial: Record<string, string>): Promise<string> {
  const root = path.join(process.cwd(), 'tmp', `changed-files-${crypto.randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  // Fan out file writes in parallel; otherwise the per-fixture cost is dominated
  // by sequential mkdir+writeFile latency, not the test logic we care about.
  await Promise.all(
    Object.entries(initial).map(async ([rel, content]) => {
      const target = path.join(root, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }),
  );
  // Inline `-c` user info on commit — avoids touching `.git/config` and the
  // lock-file race two parallel `git config` calls would hit.
  await runGit(['init', '-q', '-b', 'main'], root);
  await runGit(['add', '-A'], root);
  await runGit(
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'init'],
    root,
  );
  return root;
}

module('Utils | getChangedFilePathsInGitSince | constants', { concurrency: true }, () => {
  test('blast-radius set covers the load-bearing config files', (assert) => {
    assert.ok(BLAST_RADIUS_FILES.has('package.json'));
    assert.ok(BLAST_RADIUS_FILES.has('package-lock.json'));
    assert.ok(BLAST_RADIUS_FILES.has('deno.json'));
    assert.ok(BLAST_RADIUS_FILES.has('deno.lock'));
  });

  test('blast-radius patterns match tsconfig variants', (assert) => {
    const matches = (s: string) => BLAST_RADIUS_PATTERNS.some((re) => re.test(s));
    assert.ok(matches('tsconfig.json'));
    assert.ok(matches('tsconfig.test.json'));
    assert.ok(matches('tsconfig.build.json'));
    assert.notOk(matches('foo.json'));
  });
});

module('Utils | getChangedFilePathsInGitSince | git interaction', { concurrency: true }, () => {
  test('returns empty set when nothing changed', async (assert) => {
    const root = await makeRepo({ 'a.ts': 'export const a = 1;' });
    const result = await getChangedFilePathsInGitSince(root, 'HEAD');
    assert.equal(Result.unwrap(result).scope, 'paths', 'not blast-radius');
    assert.equal(paths(result).size, 0);
  });

  test('untracked file is reported as changed', async (assert) => {
    const root = await makeRepo({ 'a.ts': 'export const a = 1;' });
    await fs.writeFile(path.join(root, 'b.ts'), 'export const b = 2;');
    const result = await getChangedFilePathsInGitSince(root, 'HEAD');
    assert.ok(paths(result).has(path.resolve(root, 'b.ts')));
  });

  test('modified tracked file is reported as changed', async (assert) => {
    const root = await makeRepo({ 'a.ts': 'export const a = 1;' });
    await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 2;');
    const result = await getChangedFilePathsInGitSince(root, 'HEAD');
    assert.ok(paths(result).has(path.resolve(root, 'a.ts')));
  });

  test('a package.json change reports scope "everything", naming the trigger', async (assert) => {
    const root = await makeRepo({
      'a.ts': 'export const a = 1;',
      'package.json': '{}',
    });
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"x"}');
    const scan = Result.unwrap(await getChangedFilePathsInGitSince(root, 'HEAD'));
    assert.equal(scan.scope, 'everything');
    assert.equal(scan.trigger, 'package.json', 'names which file forced the full run');
  });

  test('a tsconfig.test.json change reports scope "everything"', async (assert) => {
    const root = await makeRepo({
      'a.ts': 'export const a = 1;',
      'tsconfig.test.json': '{}',
    });
    await fs.writeFile(path.join(root, 'tsconfig.test.json'), '{"compilerOptions":{}}');
    const scan = Result.unwrap(await getChangedFilePathsInGitSince(root, 'HEAD'));
    assert.equal(scan.scope, 'everything');
  });

  test('an unknown ref is a declared failure, not a rejection', async (assert) => {
    const root = await makeRepo({ 'a.ts': '' });
    const scan = await getChangedFilePathsInGitSince(root, 'no-such-ref');

    assert.notOk(scan.ok);
    assert.equal(scan.error.code, 'GitScanFailed');
    assert.equal(scan.error.data.ref, 'no-such-ref');
    assert.ok(scan.error.cause instanceof Error, "git's own error is kept as the cause");
  });
});

// `--changed` degrades to "run all tests" whenever git fails, but before this bound git could
// only ever *hang*: nothing killed a wedged child and nothing gave up waiting, so the CLI waited
// forever. That surfaced as a CI job consumed to its 25-minute timeout with no diagnostic (deno
// + Windows lane, where node:child_process can leave a spawned child's exit undelivered). An
// unbounded subprocess in the run path is the bug; these pin the bound.
//
// The wedged process must hang the SAME way on every runtime. `git hash-object --stdin` reads
// stdin until EOF, which hangs under Node (execFile leaves the pipe open) but exits under Deno
// (its node:child_process EOFs the child's stdin), so it flaked the deno lane. A process kept
// alive by a pending timer hangs regardless of stdin — spawn the current runtime (via runGit's
// injectable command) so the bound is tested against a genuinely, portably unkillable child.
const IS_DENO = typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined';
const HANG_ARGS = IS_DENO
  ? ['eval', 'setInterval(() => {}, 1e9)']
  : ['-e', 'setInterval(() => {}, 1e9)'];
module('Utils | getChangedFilePathsInGitSince | bounded execution', { concurrency: true }, () => {
  test('kills and rejects a subprocess that never exits, rather than waiting forever', async (assert) => {
    const startedAt = Date.now();
    let error: Error | undefined;
    try {
      await runGit(HANG_ARGS, process.cwd(), 300, process.execPath);
    } catch (caught) {
      error = caught as Error;
    }
    const elapsed = Date.now() - startedAt;

    assert.ok(error, 'settles as a rejection instead of hanging forever');
    assert.ok(elapsed < 10_000, `settles at the bound, not never (took ${elapsed}ms)`);
    // getChangedFsTree funnels any git error into "run all test files" (covered in
    // test/setup/get-changed-fs-tree-test.ts), so rejecting here is what converts an
    // unrecoverable hang into the documented safe fallback.
  });

  test('a healthy git still resolves normally under the default bound', async (assert) => {
    const root = await makeRepo({ 'src/app.ts': 'export const a = 1;\n' });
    await fs.writeFile(path.join(root, 'src/app.ts'), 'export const a = 2;\n');
    const changed = await getChangedFilePathsInGitSince(root, 'HEAD');
    assert.ok(changed.ok, 'the bound does not interfere with a normal lookup');
    assert.ok(paths(changed).has(path.join(root, 'src/app.ts')), 'the modified file is reported');
  });
});

/** The scanned paths, asserting the scan succeeded and was not a blast-radius short-circuit. */
function paths(scan) {
  const value = Result.unwrap(scan);
  if (value.scope !== 'paths') throw new Error(`expected scope "paths", got "${value.scope}"`);
  return value.paths;
}
