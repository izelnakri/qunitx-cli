import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { module, test } from 'qunitx';
import {
  BLAST_RADIUS_FILES,
  BLAST_RADIUS_PATTERNS,
  getChangedFilePathsInGitSince,
} from '../../lib/utils/get-changed-file-paths-in-git-since.ts';

const execFileAsync = promisify(execFile);

// Each test gets a private temp git repo. `git init` + 2 commits ≈ 60-90 ms.
// Tests run concurrently so wall-clock cost stays under 200 ms for the full module.
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
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await execFileAsync('git', ['add', '-A'], { cwd: root });
  await execFileAsync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'init'],
    { cwd: root },
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
    assert.ok(result, 'not blast-radius');
    assert.equal(result!.size, 0);
  });

  test('untracked file is reported as changed', async (assert) => {
    const root = await makeRepo({ 'a.ts': 'export const a = 1;' });
    await fs.writeFile(path.join(root, 'b.ts'), 'export const b = 2;');
    const result = await getChangedFilePathsInGitSince(root, 'HEAD');
    assert.ok(result);
    assert.ok(result!.has(path.resolve(root, 'b.ts')));
  });

  test('modified tracked file is reported as changed', async (assert) => {
    const root = await makeRepo({ 'a.ts': 'export const a = 1;' });
    await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 2;');
    const result = await getChangedFilePathsInGitSince(root, 'HEAD');
    assert.ok(result);
    assert.ok(result!.has(path.resolve(root, 'a.ts')));
  });

  test('package.json change short-circuits to null (blast radius)', async (assert) => {
    const root = await makeRepo({
      'a.ts': 'export const a = 1;',
      'package.json': '{}',
    });
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"x"}');
    const result = await getChangedFilePathsInGitSince(root, 'HEAD');
    assert.equal(result, null);
  });

  test('tsconfig.test.json change short-circuits to null', async (assert) => {
    const root = await makeRepo({
      'a.ts': 'export const a = 1;',
      'tsconfig.test.json': '{}',
    });
    await fs.writeFile(path.join(root, 'tsconfig.test.json'), '{"compilerOptions":{}}');
    const result = await getChangedFilePathsInGitSince(root, 'HEAD');
    assert.equal(result, null);
  });

  test('throws on missing ref so caller can degrade with a warning', async (assert) => {
    const root = await makeRepo({ 'a.ts': '' });
    await assert.rejects(
      getChangedFilePathsInGitSince(root, 'no-such-ref'),
      'unknown ref bubbles as a rejection',
    );
  });
});
