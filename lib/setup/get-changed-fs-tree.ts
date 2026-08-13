import { getChangedFiles } from '../utils/get-changed-files.ts';
import { getChangedFilePathsInGitSince } from '../utils/get-changed-file-paths-in-git-since.ts';
import * as MetafileCache from '../utils/metafile-cache.ts';
import * as Failure from '../result/failure.ts';
import * as Reporter from '../reporters/index.ts';
import type { Config, FSTree } from '../types.ts';

/**
 * Returns a new fsTree containing only the test files affected by changes
 * since `ref`, per the cached esbuild metafile's reverse-dependency graph.
 *
 * Falls back to returning the input fsTree unchanged (with a notice)
 * when any of these hold — they are "run-all is the safe answer" scenarios,
 * not bugs:
 *   - blast-radius file changed (package.json, tsconfig.json, …): full graph
 *     potentially affected, dep walk would miss it.
 *   - no metafile cache yet: nothing built before this run.
 *   - git failed: not a repo, ref doesn't exist, git binary missing.
 *
 * Always announces how the filter resolved (full / filtered / fallback) so users can
 * reason about why their selected suite ran.
 *
 * ```ts
 * import type { Config, FSTree } from '../types.ts';
 *
 * // Defined, not invoked: reads the metafile cache and runs git.
 * async function narrow(fsTree: FSTree, config: Config) {
 *   return getChangedFsTree(fsTree, config, 'HEAD'); // only tests affected since HEAD
 * }
 * ```
 */
export async function getChangedFsTree(
  fsTree: FSTree,
  config: Config,
  changedSince: string,
  // The git-backed change detector is injectable so the filter branches can be
  // unit-tested deterministically — without spawning a real git subprocess, whose
  // unbounded `init/add/commit` could wedge the whole test for 300s when a child's
  // exit event never arrived on the deno/Windows lane. Production always uses the
  // real default; the live integration is covered e2e in test/flags/changed-test.ts.
  getChanged: typeof getChangedFilePathsInGitSince = getChangedFilePathsInGitSince,
): Promise<FSTree> {
  const testFiles = Object.keys(fsTree);
  if (testFiles.length === 0) return fsTree;

  const { projectRoot } = config;
  const cache = await MetafileCache.read(projectRoot);
  if (!cache) {
    Reporter.info(
      config,
      `--changed: no metafile cache yet — running all ${testFiles.length} test files (cache populates on this run)`,
    );
    return fsTree;
  }

  // Three outcomes, three named shapes: a declared failure, a successful "run everything"
  // scan, and a set of paths. This used to be one variable holding `Set | null | Error`,
  // discriminated by `instanceof` — with the `null` branch ("run everything") adjacent to the
  // `size === 0` branch ("run nothing").
  //
  // `.result()` is the Task's own bridge to the value world: it settles to the bare
  // `ChangeScan | GitScanFailure` union, and one `Failure.is` check discriminates it. The
  // two-tier gate holds — a declared scan failure flows here as a value, while a bug in the
  // scanner still rejects and crashes the run loudly.
  const scan = await getChanged(projectRoot, changedSince).result();
  if (Failure.is(scan)) {
    Reporter.info(
      config,
      `--changed: ${scan.message} — running all ${testFiles.length} test files`,
    );
    return fsTree;
  } else if (scan.scope === 'everything') {
    Reporter.info(
      config,
      `--changed: blast-radius file changed (${scan.trigger}) — running all ${testFiles.length} test files`,
    );
    return fsTree;
  } else if (scan.paths.size === 0) {
    Reporter.info(
      config,
      `--changed: 0 files changed since ${changedSince} — running 0 test files`,
    );
    return {};
  }

  const affected = getChangedFiles(cache.metafile, cache.esbuildCwd, scan.paths, testFiles);
  Reporter.info(
    config,
    `--changed: ${affected.size} of ${testFiles.length} test files affected by changes since ${changedSince}`,
  );
  return Object.fromEntries(testFiles.filter((f) => affected.has(f)).map((f) => [f, null]));
}
