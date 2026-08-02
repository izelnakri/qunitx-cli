import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { createHash } from 'node:crypto';
import type { AffectedMetafile } from './get-changed-files.ts';
import { Task } from '../task/index.ts';
import { readJsonCache } from './read-json-cache.ts';

/**
 * Persistent on-disk cache of the most recent successful esbuild metafile,
 * used by `--changed` / `--since` to compute the reverse-dependency graph
 * without re-running esbuild. Lives under `node_modules/.cache/` (npm convention,
 * gitignored, survives `rm -rf tmp/`).
 *
 * The wrapper format records the absolute cwd at write time so the reader can
 * resolve metafile-relative paths the same way esbuild would, regardless of
 * where qunitx is invoked from on the next run.
 *
 * ```ts
 * import * as MetafileCache from './metafile-cache.ts';
 *
 * const payload: MetafileCache.MetafileCachePayload = {
 *   esbuildCwd: '/proj',
 *   metafile: { inputs: { 'test/a-test.ts': { imports: [{ path: 'lib/util.ts' }] } } },
 * };
 * ```
 */
interface MetafileCachePayload {
  /** `process.cwd()` at the moment the metafile was produced; metafile paths are relative to it. */
  esbuildCwd: string;
  /** The raw esbuild metafile this cache represents. */
  metafile: AffectedMetafile;
}

const CACHE_FILE = 'metafile.json';

/**
 * Distinguishes concurrent temp files. One process can have two writes in flight (a watch-mode
 * rebuild starting before the previous write settled), so the pid alone is not unique.
 */
let writeSequence = 0;

/**
 * Returns the on-disk cache path for `projectRoot`. The path embeds a SHA-1
 * tag of the absolute project root so projects that share a hoisted/symlinked
 * `node_modules` (pnpm workspaces, monorepos, integration test fixtures) write
 * to distinct files. 12 hex chars is far below collision risk for the scale of
 * "projects on one machine."
 *
 * ```ts
 * import * as MetafileCache from './metafile-cache.ts';
 *
 * MetafileCache.path('/proj'); // '/proj/node_modules/.cache/qunitx/d6f745519348/metafile.json'
 * MetafileCache.path('/other'); // same layout, different hash tag — no clash on shared node_modules
 * ```
 */
export function path(projectRoot: string): string {
  const tag = createHash('sha1').update(projectRoot).digest('hex').slice(0, 12);
  return nodePath.join(projectRoot, 'node_modules', '.cache', 'qunitx', tag, CACHE_FILE);
}

/**
 * Best-effort write; failures are swallowed because a cache miss on the next read just degrades
 * to "run all tests."
 *
 * Publishes by writing a temp file and renaming it into place, because `fs.writeFile` **truncates
 * on open**: for the whole write window the cache is an empty (then partial) file, and any reader
 * in that window parses garbage and concludes there is no cache. That is not theoretical — watch
 * mode fires `buildTestBundle` (which lands here) and *then* calls `getChangedFsTree`, so a
 * `--changed --watch` run races its own write and intermittently reports "no metafile cache yet
 * — running all N test files" instead of the affected subset. `rename` is atomic, so a reader
 * always sees either the previous complete cache or this one, never a torn one. It also makes
 * concurrent writers (two runs sharing a checkout) and a process killed mid-write safe: the
 * worst case is a leftover temp file, never a corrupt cache.
 *
 * ```ts
 * import * as MetafileCache from './metafile-cache.ts';
 *
 * await MetafileCache.write('/not/writable/anywhere', '/proj', { inputs: {} });
 * // resolves — an unwritable cache dir degrades silently, the next read is just a miss
 * ```
 */
export async function write(
  projectRoot: string,
  esbuildCwd: string,
  metafile: AffectedMetafile,
): Promise<void> {
  const file = path(projectRoot);
  const tmpFile = `${file}.${process.pid}-${++writeSequence}.tmp`;

  await Task(async () => {
    await fs.mkdir(nodePath.dirname(file), { recursive: true });
    await fs.writeFile(
      tmpFile,
      JSON.stringify({ esbuildCwd, metafile } satisfies MetafileCachePayload),
    );
    await fs.rename(tmpFile, file);
  })
    // node_modules/.cache may not be writable (read-only FS, EACCES); a cache that cannot be
    // written is a slower next run, not a failed one. The rename is what publishes the file, so
    // anything that fails before it leaves the tmpfile behind for us to drop.
    .recover(() => Task(fs.unlink(tmpFile)).ignore('metafile cache tmpfile unlink'));
}

/**
 * Reads the cached metafile. Returns `null` on miss or corruption.
 *
 * ```ts
 * import * as MetafileCache from './metafile-cache.ts';
 *
 * await MetafileCache.read('/tmp/no-such-qunitx-project'); // null — missing or corrupt cache is a miss
 * ```
 */
export function read(projectRoot: string): Task<MetafileCachePayload | null, never> {
  return readJsonCache(path(projectRoot), isMetafileCache);
}

/** A cache written by this version: esbuild's cwd, and a metafile with inputs to diff against. */
function isMetafileCache(parsed: unknown): parsed is MetafileCachePayload {
  const cache = parsed as MetafileCachePayload | null;
  return typeof cache?.esbuildCwd === 'string' && !!cache.metafile?.inputs;
}

export type { MetafileCachePayload };
