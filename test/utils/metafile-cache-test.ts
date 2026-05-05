import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { module, test } from 'qunitx';
import {
  metafileCachePath,
  readMetafileCache,
  writeMetafileCache,
} from '../../lib/utils/metafile-cache.ts';
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

module('Utils | metafile-cache', { concurrency: true }, () => {
  test('write then read round-trips esbuildCwd + metafile', async (assert) => {
    const root = await tempProjectRoot();
    await writeMetafileCache(root, '/some/cwd', SAMPLE);
    const got = await readMetafileCache(root);
    assert.ok(got, 'cache hit');
    assert.equal(got!.esbuildCwd, '/some/cwd');
    assert.deepEqual(got!.metafile, SAMPLE);
  });

  test('read returns null when file does not exist', async (assert) => {
    const root = await tempProjectRoot();
    assert.equal(await readMetafileCache(root), null);
  });

  test('read returns null on corrupt JSON', async (assert) => {
    const root = await tempProjectRoot();
    const cacheFile = metafileCachePath(root);
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, '{not-json');
    assert.equal(await readMetafileCache(root), null);
  });

  test('read returns null when payload is missing required fields', async (assert) => {
    const root = await tempProjectRoot();
    const cacheFile = metafileCachePath(root);
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify({ esbuildCwd: '/x' })); // no metafile
    assert.equal(await readMetafileCache(root), null);
  });

  test('distinct projectRoots that share a node_modules write to distinct cache files', async (assert) => {
    // Regression test for the CI failure on PR1's first run: the test fixture's
    // symlinked node_modules made every per-test project share one cache, so
    // concurrent runs overwrote each other. The path tag derived from
    // projectRoot keeps each project's cache isolated even under the symlink.
    const [rootA, rootB] = await Promise.all([tempProjectRoot(), tempProjectRoot()]);
    assert.notStrictEqual(metafileCachePath(rootA), metafileCachePath(rootB));
    // Same projectRoot must always resolve to the same path so daemon runs hit.
    assert.strictEqual(metafileCachePath(rootA), metafileCachePath(rootA));
  });

  test('write is best-effort: read-only cache dir does not throw', async (assert) => {
    // No cache dir creation — write a regular file at the would-be dir path so
    // mkdir fails (EEXIST as file). writeMetafileCache should swallow the error.
    const root = await tempProjectRoot();
    const cacheParent = path.join(root, 'node_modules', '.cache');
    await fs.mkdir(path.dirname(cacheParent), { recursive: true });
    await fs.writeFile(cacheParent, ''); // file where dir is expected → mkdir fails
    await writeMetafileCache(root, '/x', SAMPLE); // must not throw
    // And subsequent read returns null because the file was never written.
    assert.equal(await readMetafileCache(root), null);
  });
});
