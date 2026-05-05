import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { module, test } from 'qunitx';
import '../helpers/custom-asserts.ts';
import { spawnCapture } from '../helpers/shell.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';

const CWD = process.cwd();

interface ShardProject {
  cwd: string;
  testCount: number;
}

// Build a self-contained project with N independently-passing test files,
// symlinking node_modules so qunitx + esbuild resolve. Each test logs a unique
// id so the total can be reconstructed from stdout across all shards.
async function makeShardProject(testCount: number): Promise<ShardProject> {
  const id = crypto.randomUUID();
  const cwd = path.join(CWD, 'tmp', `shard-${id}`);
  await fs.mkdir(cwd, { recursive: true });
  const writes = Array.from({ length: testCount }, (_, i) => {
    const filePath = path.join(cwd, 'test', `file-${i}-test.ts`);
    const content =
      [
        `import { module, test } from 'qunitx';`,
        `module('Shard | file-${i}', () => {`,
        `  test('file-${i} ok', (assert) => assert.equal(${i}, ${i}));`,
        `});`,
      ].join('\n') + '\n';
    return writeWithMkdir(filePath, content);
  });
  await Promise.all([
    fs.symlink(path.join(CWD, 'node_modules'), path.join(cwd, 'node_modules')),
    writeWithMkdir(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: id, version: '0.0.1', type: 'module' }),
    ),
    ...writes,
  ]);
  return { cwd, testCount };
}

async function writeWithMkdir(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function runCli(project: ShardProject, args: string) {
  const id = crypto.randomUUID();
  const permit = await acquireBrowser();
  try {
    return await spawnCapture(`node ${CWD}/cli.ts ${args} --output=tmp/run-${id} --no-daemon`, {
      env: { ...process.env, FORCE_COLOR: '0' },
      cwd: project.cwd,
    });
  } finally {
    permit.release();
  }
}

// Sums every `# pass N` line in the run's stdout — one per HTML file (1 here),
// summed gives the total tests that actually executed.
function countPasses(stdout: string): number {
  return [...stdout.matchAll(/^# pass (\d+)$/gm)].reduce((sum, m) => sum + Number(m[1]), 0);
}

module('--shard flag', { concurrency: true }, () => {
  test('--shard=1/2 + --shard=2/2 partition the input exhaustively and disjointly', async (assert) => {
    // Eight test files give SHA-1 ≈ 50/50 odds of both shards being non-empty,
    // and even an unlucky 8/0 split still validates union coverage.
    const project = await makeShardProject(8);

    const [a, b] = await Promise.all([
      runCli(project, 'test/ --shard=1/2'),
      runCli(project, 'test/ --shard=2/2'),
    ]);

    assert.exitCode(a, 0);
    assert.exitCode(b, 0);

    // Every input file appears in exactly one shard's run.
    const aPasses = countPasses(a.stdout);
    const bPasses = countPasses(b.stdout);
    assert.equal(
      aPasses + bPasses,
      project.testCount,
      `union covers all ${project.testCount} files (a=${aPasses}, b=${bPasses})`,
    );

    // Diagnostic line confirms the filter ran.
    assert.regex(a, /# --shard: \d+ of \d+ test files in shard 1\/2/);
    assert.regex(b, /# --shard: \d+ of \d+ test files in shard 2\/2/);
  });

  test('--shard=1/1 is a no-op (every file runs)', async (assert) => {
    const project = await makeShardProject(3);
    const result = await runCli(project, 'test/ --shard=1/1');
    assert.exitCode(result, 0);
    assert.equal(countPasses(result.stdout), project.testCount);
  });

  test('--shard with more shards than files: most shards are empty, union still covers all', async (assert) => {
    const project = await makeShardProject(2);
    const results = await Promise.all([
      runCli(project, 'test/ --shard=1/5'),
      runCli(project, 'test/ --shard=2/5'),
      runCli(project, 'test/ --shard=3/5'),
      runCli(project, 'test/ --shard=4/5'),
      runCli(project, 'test/ --shard=5/5'),
    ]);
    results.forEach((r, i) => assert.exitCode(r, 0, `shard ${i + 1}/5 exited 0`));
    const total = results.reduce((sum, r) => sum + countPasses(r.stdout), 0);
    assert.equal(
      total,
      project.testCount,
      `union of all 5 shards covers ${project.testCount} files`,
    );
  });

  test('invalid --shard value exits 1 with a clear error', async (assert) => {
    // Fails early in parseCliFlags — no project setup needed; pin against a
    // throwaway cwd so we don't bother with the symlink dance.
    const dir = path.join(CWD, 'tmp', `shard-invalid-${crypto.randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), '{"name":"x","type":"module"}');
    let captured: { code: number | null; stderr: string } | null = null;
    try {
      await spawnCapture(`node ${CWD}/cli.ts --shard=abc`, {
        env: { ...process.env, FORCE_COLOR: '0' },
        cwd: dir,
      });
    } catch (err) {
      captured = err as { code: number | null; stderr: string };
    }
    assert.ok(captured, 'cli should reject and exit non-zero');
    assert.equal(captured!.code, 1);
    assert.ok(captured!.stderr.includes('Invalid --shard value'), 'stderr explains the bad value');
  });
});
