import fs from 'node:fs/promises';
import nodePath from 'node:path';
import { createHash } from 'node:crypto';
import type { AffectedMetafile } from './get-changed-files.ts';

/**
 * Persistent on-disk cache of the most recent successful esbuild metafile,
 * used by `--changed` / `--since` to compute the reverse-dependency graph
 * without re-running esbuild. Lives under `node_modules/.cache/` (npm convention,
 * gitignored, survives `rm -rf tmp/`).
 *
 * The wrapper format records the absolute cwd at write time so the reader can
 * resolve metafile-relative paths the same way esbuild would, regardless of
 * where qunitx is invoked from on the next run.
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
 */
export async function write(
  projectRoot: string,
  esbuildCwd: string,
  metafile: AffectedMetafile,
): Promise<void> {
  const file = path(projectRoot);
  const tmpFile = `${file}.${process.pid}-${++writeSequence}.tmp`;
  try {
    await fs.mkdir(nodePath.dirname(file), { recursive: true });
    await fs.writeFile(
      tmpFile,
      JSON.stringify({ esbuildCwd, metafile } satisfies MetafileCachePayload),
    );
    await fs.rename(tmpFile, file);
  } catch {
    /* node_modules/.cache may not be writable (read-only FS, EACCES); silent degrade. */
    await fs.unlink(tmpFile).catch(() => {});
  }
}

/** Reads the cached metafile. Returns `null` on miss or corruption. */
export async function read(projectRoot: string): Promise<MetafileCachePayload | null> {
  try {
    const raw = await fs.readFile(path(projectRoot), 'utf8');
    const parsed = JSON.parse(raw) as MetafileCachePayload;
    if (typeof parsed?.esbuildCwd !== 'string' || !parsed.metafile?.inputs) return null;
    return parsed;
  } catch {
    return null;
  }
}

export type { MetafileCachePayload };
