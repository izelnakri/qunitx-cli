import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FSTree } from '../types.ts';

/**
 * Returns the subset of `fsTree` whose entries fall in shard `shardIndex` of
 * `shardTotal`. Used by `--shard=N/M` for distributed-CI matrix jobs: every
 * shard number returns a disjoint slice of the input tree, and across all M
 * shards every input file appears in exactly one shard.
 *
 * Files are partitioned by SHA-1 of their projectRoot-relative path normalized
 * to forward slashes (so the same file on Windows and POSIX hashes to the same
 * shard). SHA-1 → uniform distribution; modulo `shardTotal` is exact under the
 * assumption shardTotal ≪ 2³². The cost is ~1 µs per file even on tens-of-
 * thousands-of-files repos — a non-factor next to the test runtime saved by
 * sharding.
 */
export function shardFsTree(
  fsTree: FSTree,
  projectRoot: string,
  shardIndex: number,
  shardTotal: number,
): FSTree {
  return Object.fromEntries(
    Object.entries(fsTree).filter(
      ([abs]) => shardOf(relForHashing(projectRoot, abs), shardTotal) === shardIndex,
    ),
  );
}

function relForHashing(projectRoot: string, abs: string): string {
  return path.relative(projectRoot, abs).split(path.sep).join('/');
}

function shardOf(rel: string, shardTotal: number): number {
  return createHash('sha1').update(rel).digest().readUInt32BE(0) % shardTotal;
}
