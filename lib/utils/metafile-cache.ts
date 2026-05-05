import fs from 'node:fs/promises';
import path from 'node:path';
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
 * Returns the on-disk cache path for `projectRoot`. The path embeds a SHA-1
 * tag of the absolute project root so projects that share a hoisted/symlinked
 * `node_modules` (pnpm workspaces, monorepos, integration test fixtures) write
 * to distinct files. 12 hex chars is far below collision risk for the scale of
 * "projects on one machine."
 */
export function metafileCachePath(projectRoot: string): string {
  const tag = createHash('sha1').update(projectRoot).digest('hex').slice(0, 12);
  return path.join(projectRoot, 'node_modules', '.cache', 'qunitx', tag, CACHE_FILE);
}

/** Best-effort write; failures are swallowed because cache miss on the next read just degrades to "run all tests." */
export async function writeMetafileCache(
  projectRoot: string,
  esbuildCwd: string,
  metafile: AffectedMetafile,
): Promise<void> {
  const file = metafileCachePath(projectRoot);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ esbuildCwd, metafile } satisfies MetafileCachePayload),
    );
  } catch {
    /* node_modules/.cache may not be writable (read-only FS, EACCES); silent degrade. */
  }
}

/** Reads the cached metafile. Returns `null` on miss or corruption. */
export async function readMetafileCache(projectRoot: string): Promise<MetafileCachePayload | null> {
  try {
    const raw = await fs.readFile(metafileCachePath(projectRoot), 'utf8');
    const parsed = JSON.parse(raw) as MetafileCachePayload;
    if (typeof parsed?.esbuildCwd !== 'string' || !parsed.metafile?.inputs) return null;
    return parsed;
  } catch {
    return null;
  }
}

export type { MetafileCachePayload };
