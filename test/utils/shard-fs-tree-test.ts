import path from 'node:path';
import { module, test } from 'qunitx';
import { shardFsTree } from '../../lib/utils/shard-fs-tree.ts';
import type { FSTree } from '../../lib/types.ts';

// Pure-function tests — no I/O, no spawning. Each module runs in <2 ms locally.

const PROJECT_ROOT = '/proj';
const abs = (rel: string) => path.resolve(PROJECT_ROOT, rel);

function fsTreeOf(rels: string[]): FSTree {
  return Object.fromEntries(rels.map((r) => [abs(r), null]));
}

module('Utils | shardFsTree | partition properties', { concurrency: true }, () => {
  test('union of every shard equals the input set (no file dropped, none duplicated)', (assert) => {
    const files = Array.from({ length: 50 }, (_, i) => `test/file-${i}.ts`);
    const tree = fsTreeOf(files);
    const M = 4;
    const allShards = Array.from({ length: M }, (_, n) =>
      Object.keys(shardFsTree(tree, PROJECT_ROOT, n, M)),
    );
    const flattened = allShards.flat();
    assert.equal(flattened.length, files.length, 'every file lands in exactly one shard');
    assert.deepEqual(flattened.sort(), files.map(abs).sort(), 'union covers every input file');
    // No duplicates — `Set` size equals array size when partitioning is exact.
    assert.equal(new Set(flattened).size, flattened.length, 'no file appears in two shards');
  });

  test('shards are disjoint pairwise', (assert) => {
    const files = Array.from({ length: 50 }, (_, i) => `test/file-${i}.ts`);
    const tree = fsTreeOf(files);
    const M = 4;
    const shards = Array.from(
      { length: M },
      (_, n) => new Set(Object.keys(shardFsTree(tree, PROJECT_ROOT, n, M))),
    );
    for (let a = 0; a < M; a++) {
      for (let b = a + 1; b < M; b++) {
        const overlap = [...shards[a]].filter((f) => shards[b].has(f));
        assert.equal(overlap.length, 0, `shard ${a} and shard ${b} are disjoint`);
      }
    }
  });

  test('distribution is reasonably uniform across shards', (assert) => {
    // 100 files / 4 shards → expected 25 per shard. SHA-1 should keep every
    // shard within a tight band (10..40) for this size; this guards against
    // a hash-input regression that would suddenly cluster everything in one shard.
    const files = Array.from({ length: 100 }, (_, i) => `test/file-${i}.ts`);
    const tree = fsTreeOf(files);
    const M = 4;
    const counts = Array.from(
      { length: M },
      (_, n) => Object.keys(shardFsTree(tree, PROJECT_ROOT, n, M)).length,
    );
    counts.forEach((c, n) => {
      assert.ok(c >= 10 && c <= 40, `shard ${n} has ${c} files (expected ~25, allowed 10–40)`);
    });
  });
});

module('Utils | shardFsTree | determinism', { concurrency: true }, () => {
  test('same input → same shard assignment (deterministic across calls)', (assert) => {
    const tree = fsTreeOf(['test/a.ts', 'test/b.ts', 'test/c.ts']);
    const a = shardFsTree(tree, PROJECT_ROOT, 0, 3);
    const b = shardFsTree(tree, PROJECT_ROOT, 0, 3);
    assert.deepEqual(Object.keys(a), Object.keys(b));
  });

  // Cross-platform stability of the hash input (path.sep → '/' normalisation
  // before SHA-1) is verified by the OS matrix in CI rather than here:
  // path.resolve / path.relative behave per-platform, so a single-OS test
  // can't faithfully simulate the other's separator. The integration test
  // in test/flags/shard-test.ts hits the real path code on whichever OS
  // it runs.
});

module('Utils | shardFsTree | edge cases', { concurrency: true }, () => {
  test('empty fsTree returns empty for every shard', (assert) => {
    for (const M of [1, 4]) {
      for (let n = 0; n < M; n++) {
        assert.equal(Object.keys(shardFsTree({}, PROJECT_ROOT, n, M)).length, 0);
      }
    }
  });

  test('shardTotal=1 returns the full tree on shard 0', (assert) => {
    const tree = fsTreeOf(['test/a.ts', 'test/b.ts']);
    const result = shardFsTree(tree, PROJECT_ROOT, 0, 1);
    assert.deepEqual(Object.keys(result).sort(), Object.keys(tree).sort());
  });

  test('more shards than files: some shards are empty, every file still lands once', (assert) => {
    const tree = fsTreeOf(['test/a.ts', 'test/b.ts']);
    const M = 10;
    const allFiles = Array.from({ length: M }, (_, n) =>
      Object.keys(shardFsTree(tree, PROJECT_ROOT, n, M)),
    ).flat();
    assert.deepEqual(allFiles.sort(), Object.keys(tree).sort());
  });
});
