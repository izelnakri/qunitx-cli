import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readTimingCache, computeFileTimes } from '../../lib/commands/run.ts';

const CWD = process.cwd();

// ---------------------------------------------------------------------------
// readTimingCache
// ---------------------------------------------------------------------------

module('Commands | run | readTimingCache', { concurrency: true }, () => {
  test('returns {} when the file does not exist', async (assert) => {
    const result = await readTimingCache(`${CWD}/tmp/nonexistent-${randomUUID()}`);
    assert.deepEqual(result, {});
  });

  test('parses a valid timing cache', async (assert) => {
    const dir = `${CWD}/tmp/timing-cache-test-${randomUUID()}`;
    await fs.mkdir(`${dir}/tmp`, { recursive: true });
    const data = { 'test/foo.ts': 120, 'test/bar.ts': 340 };
    await fs.writeFile(`${dir}/tmp/test-timings.json`, JSON.stringify(data));
    assert.deepEqual(await readTimingCache(dir), data);
  });

  test('returns {} for invalid JSON', async (assert) => {
    const dir = `${CWD}/tmp/timing-cache-test-${randomUUID()}`;
    await fs.mkdir(`${dir}/tmp`, { recursive: true });
    await fs.writeFile(`${dir}/tmp/test-timings.json`, 'not json {{{');
    assert.deepEqual(await readTimingCache(dir), {});
  });

  test('returns {} when the file contains a non-object', async (assert) => {
    const dir = `${CWD}/tmp/timing-cache-test-${randomUUID()}`;
    await fs.mkdir(`${dir}/tmp`, { recursive: true });
    await fs.writeFile(`${dir}/tmp/test-timings.json`, JSON.stringify([1, 2, 3]));
    assert.deepEqual(await readTimingCache(dir), {});
  });
});

// ---------------------------------------------------------------------------
// computeFileTimes
// ---------------------------------------------------------------------------

module('Commands | run | computeFileTimes', { concurrency: true }, () => {
  test('distributes wall time proportionally by weight', (assert) => {
    const groups = [['a.ts', 'b.ts']];
    const weights = new Map([
      ['a.ts', 100],
      ['b.ts', 300],
    ]);
    const wallTimes = new Map([[0, 1000]]);
    const result = computeFileTimes(groups, weights, wallTimes);
    assert.equal(result.get('a.ts'), 250, 'a.ts gets 25% (weight 100/400)');
    assert.equal(result.get('b.ts'), 750, 'b.ts gets 75% (weight 300/400)');
  });

  test('distributes evenly when all weights are 0', (assert) => {
    const groups = [['a.ts', 'b.ts', 'c.ts']];
    const weights = new Map([
      ['a.ts', 0],
      ['b.ts', 0],
      ['c.ts', 0],
    ]);
    const wallTimes = new Map([[0, 900]]);
    const result = computeFileTimes(groups, weights, wallTimes);
    assert.equal(result.get('a.ts'), 300);
    assert.equal(result.get('b.ts'), 300);
    assert.equal(result.get('c.ts'), 300);
  });

  test('handles multiple groups independently', (assert) => {
    const groups = [['a.ts'], ['b.ts', 'c.ts']];
    const weights = new Map([
      ['a.ts', 100],
      ['b.ts', 200],
      ['c.ts', 200],
    ]);
    const wallTimes = new Map([
      [0, 500],
      [1, 800],
    ]);
    const result = computeFileTimes(groups, weights, wallTimes);
    assert.equal(result.get('a.ts'), 500, 'sole file in group gets full wall time');
    assert.equal(result.get('b.ts'), 400, 'equal-weight files split group time');
    assert.equal(result.get('c.ts'), 400);
  });

  test('skips groups with no recorded wall time', (assert) => {
    const groups = [['a.ts'], ['b.ts']];
    const weights = new Map([
      ['a.ts', 100],
      ['b.ts', 100],
    ]);
    const wallTimes = new Map([[0, 1000]]); // group 1 timed out — not in map
    const result = computeFileTimes(groups, weights, wallTimes);
    assert.ok(result.has('a.ts'), 'group 0 included');
    assert.notOk(result.has('b.ts'), 'group 1 excluded (timed out)');
  });
});
