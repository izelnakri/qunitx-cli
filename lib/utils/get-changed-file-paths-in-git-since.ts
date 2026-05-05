import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Exact basenames whose modification invalidates the entire test suite. A change
 * to any of these short-circuits `getChangedFilePathsInGitSince` to `null`, signalling
 * the caller to skip filtering and run everything. The qunitx config lives
 * inside `package.json` per project convention, so package.json alone covers it.
 */
const BLAST_RADIUS_FILES = new Set(['package.json', 'package-lock.json', 'deno.json', 'deno.lock']);
/**
 * Basename regexes with the same blast-radius semantics. Currently catches
 * `tsconfig.json` and editor variants like `tsconfig.test.json` /
 * `tsconfig.build.json`.
 */
const BLAST_RADIUS_PATTERNS = [/^tsconfig.*\.json$/];

/**
 * Resolves the set of working-tree paths that differ from `ref`, plus all
 * uncommitted modifications/additions. Returns absolute paths.
 *
 * Returns `null` when any "blast-radius" file (package.json, tsconfig*.json, …)
 * has changed — those changes can affect every test and must skip the
 * dep-graph filter. The caller treats `null` as "run all tests."
 *
 * Throws on git failure (not a repo, ref doesn't exist, git missing). Callers
 * should catch and degrade to the run-all path with a stderr note.
 */
export async function getChangedFilePathsInGitSince(
  projectRoot: string,
  ref: string,
): Promise<Set<string> | null> {
  const [diffOut, statusOut] = await Promise.all([
    execFileAsync('git', ['diff', '--name-only', '--no-renames', ref, '--', projectRoot], {
      cwd: projectRoot,
      maxBuffer: 16 * 1024 * 1024,
    }).then((r) => r.stdout),
    execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: projectRoot,
      maxBuffer: 16 * 1024 * 1024,
    }).then((r) => r.stdout),
  ]);

  // `git status --porcelain` lines look like "XY path" or "XY path -> newpath"
  // for renames. We disabled renames in `git diff` above; for status, take the
  // rightmost path (post-rename name is what's currently on disk).
  const fromStatus = (line: string) => {
    const rest = line.slice(3);
    const arrow = rest.indexOf(' -> ');
    return arrow === -1 ? rest : rest.slice(arrow + 4);
  };
  const relPaths = new Set([
    ...diffOut.split('\n').filter(Boolean),
    ...statusOut
      .split('\n')
      .filter((l) => l.length >= 4)
      .map(fromStatus),
  ]);

  const isBlastRadius = (rel: string) => {
    const base = path.basename(rel);
    return BLAST_RADIUS_FILES.has(base) || BLAST_RADIUS_PATTERNS.some((re) => re.test(base));
  };
  if (Array.from(relPaths).some(isBlastRadius)) return null;

  return new Set(Array.from(relPaths, (rel) => path.resolve(projectRoot, rel)));
}

export { BLAST_RADIUS_FILES, BLAST_RADIUS_PATTERNS };
