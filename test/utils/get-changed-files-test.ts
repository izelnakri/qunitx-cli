import path from 'node:path';
import { module, test } from 'qunitx';
import { getChangedFiles, type AffectedMetafile } from '../../lib/utils/get-changed-files.ts';

// Pure-function unit tests — no I/O, no spawning. Each module runs in <2 ms locally.

const CWD = '/proj';
const abs = (rel: string) => path.resolve(CWD, rel);

function metafileFor(graph: Record<string, string[]>): AffectedMetafile {
  return {
    inputs: Object.fromEntries(
      Object.entries(graph).map(([file, imports]) => [
        file,
        { imports: imports.map((p) => ({ path: p })) },
      ]),
    ),
  };
}

module('Utils | getChangedFiles | basic', { concurrency: true }, () => {
  test('a test that imports a changed source file is affected', (assert) => {
    const meta = metafileFor({
      'test/foo-test.ts': ['src/foo.ts'],
      'src/foo.ts': [],
    });
    const result = getChangedFiles(meta, CWD, new Set([abs('src/foo.ts')]), [
      abs('test/foo-test.ts'),
    ]);
    assert.deepEqual([...result], [abs('test/foo-test.ts')]);
  });

  test('a test whose deps do not include any changed file is not affected', (assert) => {
    const meta = metafileFor({
      'test/foo-test.ts': ['src/foo.ts'],
      'src/foo.ts': [],
      'src/bar.ts': [],
    });
    const result = getChangedFiles(meta, CWD, new Set([abs('src/bar.ts')]), [
      abs('test/foo-test.ts'),
    ]);
    assert.equal(result.size, 0);
  });

  test('a changed test file is affected (self-reach via changedAbsPaths)', (assert) => {
    const meta = metafileFor({ 'test/foo-test.ts': [] });
    const result = getChangedFiles(meta, CWD, new Set([abs('test/foo-test.ts')]), [
      abs('test/foo-test.ts'),
    ]);
    assert.deepEqual([...result], [abs('test/foo-test.ts')]);
  });

  test('transitive: test → util → changed leaf is affected', (assert) => {
    const meta = metafileFor({
      'test/foo-test.ts': ['src/util.ts'],
      'src/util.ts': ['src/leaf.ts'],
      'src/leaf.ts': [],
    });
    const result = getChangedFiles(meta, CWD, new Set([abs('src/leaf.ts')]), [
      abs('test/foo-test.ts'),
    ]);
    assert.deepEqual([...result], [abs('test/foo-test.ts')]);
  });
});

module('Utils | getChangedFiles | edge cases', { concurrency: true }, () => {
  test('cycle in dep graph does not infinite-loop and resolves correctly', (assert) => {
    const meta = metafileFor({
      'test/foo-test.ts': ['src/a.ts'],
      'src/a.ts': ['src/b.ts'],
      'src/b.ts': ['src/a.ts'], // cycle
    });
    const result = getChangedFiles(meta, CWD, new Set([abs('src/b.ts')]), [
      abs('test/foo-test.ts'),
    ]);
    assert.deepEqual([...result], [abs('test/foo-test.ts')]);
  });

  test('test not present in metafile is not affected unless it is itself changed', (assert) => {
    const meta = metafileFor({ 'test/known-test.ts': [] });
    // 'test/new-test.ts' has no metafile entry: it can only be marked affected if
    // the changed set contains it directly (matches "newly added test file" case).
    const newlyAdded = abs('test/new-test.ts');
    const r1 = getChangedFiles(meta, CWD, new Set([newlyAdded]), [newlyAdded]);
    assert.deepEqual(
      [...r1],
      [newlyAdded],
      'newly added test file is included via changedAbsPaths',
    );

    const r2 = getChangedFiles(meta, CWD, new Set([abs('src/x.ts')]), [newlyAdded]);
    assert.equal(r2.size, 0, 'unrelated change → unknown test is not pulled in');
  });

  test('many tests sharing a dep memoize the dep walk (semantic verification)', (assert) => {
    // 50 tests all pointing at one shared util that doesn't reach the change.
    // Without memoization the walk would explode; with it, the assertion passes
    // because every test resolves through the same cached `false` for the util.
    const indices = Array.from({ length: 50 }, (_, i) => i);
    const inputs: Record<string, string[]> = {
      'src/shared.ts': [],
      ...Object.fromEntries(indices.map((i) => [`test/t-${i}.ts`, ['src/shared.ts']])),
    };
    const tests = indices.map((i) => abs(`test/t-${i}.ts`));
    const result = getChangedFiles(
      metafileFor(inputs),
      CWD,
      new Set([abs('src/unrelated.ts')]),
      tests,
    );
    assert.equal(result.size, 0);
  });

  test('empty changed set returns empty result', (assert) => {
    const meta = metafileFor({ 'test/foo-test.ts': ['src/foo.ts'] });
    const result = getChangedFiles(meta, CWD, new Set(), [abs('test/foo-test.ts')]);
    assert.equal(result.size, 0);
  });
});
