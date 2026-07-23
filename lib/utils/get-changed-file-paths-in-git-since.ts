import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// node:timers' setTimeout returns an unref-able Timer in both Node and Deno; Deno's bare
// global is the Web variant, which returns a number with no .unref().
import { setTimeout, clearTimeout } from 'node:timers';
import path from 'node:path';
import * as Result from '../result/index.ts';

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
export function runGit(
  args: string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
  // `command` is injectable only so the bound can be tested with a process that hangs
  // deterministically. Production always spawns git. A test must not lean on a real git that
  // *happens* to hang — `git hash-object --stdin` hangs under Node but exits under Deno (whose
  // node:child_process EOFs the child's stdin), which flaked the deno lane (run 29512448230).
  command = 'git',
): Promise<string> {
  const pending = execFileAsync(command, args, {
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
 * What a change scan found.
 *
 * `everything` is a *successful* scan, not a failure: a blast-radius file changed, so the
 * dep-graph filter cannot be trusted and the whole suite must run. Making that a named
 * variant is the point of this type. It used to be `null`, returned alongside a `Set` and
 * against a *throw* for real failure — so the caller held a `Set<string> | null | Error` and
 * discriminated it by `instanceof`, with `changed === null` ("run everything") sitting
 * directly beside `changed.size === 0` ("run nothing"). Two adjacent branches, opposite
 * meanings, one of them a sentinel.
 */
export type ChangeScan =
  { scope: 'everything'; trigger: string } | { scope: 'paths'; paths: Set<string> };

/** git could not answer: not a repo, unknown ref, git missing, or it exceeded `timeoutMs`. */
export const GitScanFailed = Result.Failure.define(
  'GitScanFailed',
  (data: { ref: string; reason: string }) => `git lookup for "${data.ref}" failed: ${data.reason}`,
);

/**
 * Resolves the working-tree paths that differ from `ref`, plus all uncommitted
 * modifications/additions, as absolute paths — or `scope: 'everything'` when a blast-radius
 * file (package.json, tsconfig*.json, …) changed.
 *
 * `timeoutMs` is injectable for tests; production always uses the default.
 */
export async function getChangedFilePathsInGitSince(
  projectRoot: string,
  ref: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<Result.Result<ChangeScan, Result.Failure.Of<typeof GitScanFailed>>> {
  // The boundary wraps the two git calls and nothing else, so "any Error" is a tight enough
  // declaration: execFile rejects with a numeric `code` on non-zero exit and a string `code`
  // on ENOENT, and the timeout race rejects with a plain Error — one matcher covers all three
  // without also swallowing a bug from the parsing below.
  const outputs = await Result.try(
    () =>
      Promise.all([
        runGit(
          ['diff', '--name-only', '--no-renames', ref, '--', projectRoot],
          projectRoot,
          timeoutMs,
        ),
        runGit(['status', '--porcelain', '--untracked-files=all'], projectRoot, timeoutMs),
      ]),
    { catch: Result.instanceOf(Error) },
  );
  if (!outputs.ok) {
    return Result.err(
      GitScanFailed(
        { ref, reason: outputs.error.message.split('\n')[0] },
        { cause: outputs.error },
      ),
    );
  }
  const [diffOut, statusOut] = outputs.value;

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
  // Naming the file that triggered it, which the old `null` could not carry — the caller
  // could say "a blast-radius file changed" but never which one.
  const trigger = Array.from(relPaths).find(isBlastRadius);
  if (trigger !== undefined) return Result.ok({ scope: 'everything', trigger });

  return Result.ok({
    scope: 'paths',
    paths: new Set(Array.from(relPaths, (rel) => path.resolve(projectRoot, rel))),
  });
}

export { BLAST_RADIUS_FILES, BLAST_RADIUS_PATTERNS, GIT_TIMEOUT_MS };
