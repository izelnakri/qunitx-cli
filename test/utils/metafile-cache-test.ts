import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { module, test } from 'qunitx';
import * as MetafileCache from '../../lib/utils/metafile-cache.ts';
import type { AffectedMetafile } from '../../lib/utils/get-changed-files.ts';

async function tempProjectRoot(): Promise<string> {
  const root = path.join(process.cwd(), 'tmp', `metafile-cache-${crypto.randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  return root;
}

const SAMPLE: AffectedMetafile = {
  inputs: {
    'test/foo.ts': { imports: [{ path: 'src/foo.ts' }] },
    'src/foo.ts': { imports: [] },
  },
};

module('Utils | MetafileCache', { concurrency: true }, () => {
  test('write then read round-trips esbuildCwd + metafile', async (assert) => {
    const root = await tempProjectRoot();
    await MetafileCache.write(root, '/some/cwd', SAMPLE);
    const got = await MetafileCache.read(root);
    assert.ok(got, 'cache hit');
    assert.equal(got!.esbuildCwd, '/some/cwd');
    assert.deepEqual(got!.metafile, SAMPLE);
  });

  test('read returns null when file does not exist', async (assert) => {
    const root = await tempProjectRoot();
    assert.equal(await MetafileCache.read(root), null);
  });

  test('read returns null on corrupt JSON', async (assert) => {
    const root = await tempProjectRoot();
    const cacheFile = MetafileCache.path(root);
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, '{not-json');
    assert.equal(await MetafileCache.read(root), null);
  });

  test('read returns null when payload is missing required fields', async (assert) => {
    const root = await tempProjectRoot();
    const cacheFile = MetafileCache.path(root);
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify({ esbuildCwd: '/x' })); // no metafile
    assert.equal(await MetafileCache.read(root), null);
  });

  test('distinct projectRoots that share a node_modules write to distinct cache files', async (assert) => {
    // Regression test for the CI failure on PR1's first run: the test fixture's
    // symlinked node_modules made every per-test project share one cache, so
    // concurrent runs overwrote each other. The path tag derived from
    // projectRoot keeps each project's cache isolated even under the symlink.
    const [rootA, rootB] = await Promise.all([tempProjectRoot(), tempProjectRoot()]);
    assert.notStrictEqual(MetafileCache.path(rootA), MetafileCache.path(rootB));
    // Same projectRoot must always resolve to the same path so daemon runs hit.
    assert.strictEqual(MetafileCache.path(rootA), MetafileCache.path(rootA));
  });

  test('write is best-effort: read-only cache dir does not throw', async (assert) => {
    // No cache dir creation — write a regular file at the would-be dir path so
    // mkdir fails (EEXIST as file). MetafileCache.write should swallow the error.
    const root = await tempProjectRoot();
    const cacheParent = path.join(root, 'node_modules', '.cache');
    await fs.mkdir(path.dirname(cacheParent), { recursive: true });
    await fs.writeFile(cacheParent, ''); // file where dir is expected → mkdir fails
    await MetafileCache.write(root, '/x', SAMPLE); // must not throw
    // And subsequent read returns null because the file was never written.
    assert.equal(await MetafileCache.read(root), null);
  });
});

// The cache is written by a build and read by --changed, and in watch mode those happen in the
// SAME run: run.ts fires buildTestBundle (which writes here) and then calls getChangedFsTree
// (which reads). `fs.writeFile` truncates on open, so an in-place write leaves the cache empty
// for the whole write window — a reader that lands there parses garbage, concludes "no metafile
// cache yet", and silently runs every test file instead of the affected subset. That surfaced as
// an intermittent CI failure of `--changed --watch scopes only the initial run`, worse under load
// because a slower write widens the window. These pin the atomic-publish behaviour that fixes it.
module('Utils | MetafileCache | atomic publish', { concurrency: true }, () => {
  // Big enough that the write cannot plausibly complete between the calls below — an in-place
  // write is observably torn here (19/20 reads before the fix), so this needs no timing luck.
  const BIG: AffectedMetafile = {
    inputs: Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [
        `src/f${i}.ts`,
        { imports: [{ path: `src/d${i}.ts` }] },
      ]),
    ),
  };

  test('a read during an in-flight write never sees a torn cache', async (assert) => {
    const root = await tempProjectRoot();
    await MetafileCache.write(root, '/cwd', BIG);

    let torn = 0;
    for (let i = 0; i < 20; i++) {
      MetafileCache.write(root, '/cwd', BIG); // in flight, exactly as watch mode leaves it
      if (!(await MetafileCache.read(root))) torn++;
    }
    assert.equal(torn, 0, 'every concurrent read saw a complete cache');
  });

  test('the previous cache stays readable until the new one is complete', async (assert) => {
    const root = await tempProjectRoot();
    await MetafileCache.write(root, '/first', SAMPLE);

    MetafileCache.write(root, '/second', BIG); // in flight
    const during = await MetafileCache.read(root);
    assert.ok(during, 'never a miss mid-write');
    assert.ok(
      during!.esbuildCwd === '/first' || during!.esbuildCwd === '/second',
      'sees one whole cache or the other, never a blend',
    );
  });

  test('concurrent writers cannot corrupt each other', async (assert) => {
    const root = await tempProjectRoot();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => MetafileCache.write(root, `/cwd-${i}`, BIG)),
    );
    const got = await MetafileCache.read(root);
    assert.ok(got, 'the cache is valid after 8 racing writers');
    assert.equal(Object.keys(got!.metafile.inputs).length, 400, 'and complete, not truncated');
  });

  test('publishing leaves no temp files behind', async (assert) => {
    const root = await tempProjectRoot();
    await MetafileCache.write(root, '/cwd', SAMPLE);
    const dir = path.dirname(MetafileCache.path(root));
    const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'the temp file is renamed, not abandoned');
  });
});
