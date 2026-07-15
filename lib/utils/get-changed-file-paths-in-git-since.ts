import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// node:timers' setTimeout returns an unref-able Timer in both Node and Deno; Deno's bare
// global is the Web variant, which returns a number with no .unref().
import { setTimeout, clearTimeout } from 'node:timers';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Upper bound on a single git invocation. `--changed` already degrades to "run all tests" when
 * git fails, so a stuck git should *reject* rather than wedge the run — without a bound the CLI
 * hangs forever, since neither git nor the caller ever gives up. 30s is orders of magnitude
 * above a healthy `git status` on a large repo, so it only fires on a genuine wedge.
 */
const GIT_TIMEOUT_MS = 30_000;
/**
 * Extra window after `execFile`'s own timeout before the outer race gives up. Lets execFile's
 * kill land first (its error names the signal, which is the more useful diagnostic) and only
 * falls through when the child's exit is never delivered at all.
 */
const GIT_KILL_GRACE_MS = 2_000;

/**
 * Runs one git command with a hard upper bound on how long it can take.
 *
 * Two layers, because they cover different failures: `execFile`'s own `timeout` kills a child
 * that is merely slow, while the outer race guarantees *this promise settles* even if the
 * child's exit event never arrives — the case where killing the child doesn't help because
 * nobody is listening for it to die. That second layer is what turns an unkillable hang into a
 * normal rejection the caller already knows how to degrade on.
 */
export function runGit(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const pending = execFileAsync('git', args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  }).then((result) => result.stdout);

  let timer: ReturnType<typeof setTimeout>;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`)),
      timeoutMs + GIT_KILL_GRACE_MS,
    );
    timer.unref?.();
  });

  return Promise.race([pending, bound]).finally(() => clearTimeout(timer));
}

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
 * Throws on git failure (not a repo, ref doesn't exist, git missing, or git exceeding
 * `timeoutMs`). Callers should catch and degrade to the run-all path with a stderr note.
 *
 * `timeoutMs` is injectable for tests; production always uses the default.
 */
export async function getChangedFilePathsInGitSince(
  projectRoot: string,
  ref: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<Set<string> | null> {
  const [diffOut, statusOut] = await Promise.all([
    runGit(['diff', '--name-only', '--no-renames', ref, '--', projectRoot], projectRoot, timeoutMs),
    runGit(['status', '--porcelain', '--untracked-files=all'], projectRoot, timeoutMs),
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

export { BLAST_RADIUS_FILES, BLAST_RADIUS_PATTERNS, GIT_TIMEOUT_MS };
