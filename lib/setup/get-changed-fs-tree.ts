import { getChangedFiles } from '../utils/get-changed-files.ts';
import { getChangedFilePathsInGitSince } from '../utils/get-changed-file-paths-in-git-since.ts';
import * as MetafileCache from '../utils/metafile-cache.ts';
import type { FSTree } from '../types.ts';

/**
 * Returns a new fsTree containing only the test files affected by changes
 * since `ref`, per the cached esbuild metafile's reverse-dependency graph.
 *
 * Falls back to returning the input fsTree unchanged (with a stdout note)
 * when any of these hold — they are "run-all is the safe answer" scenarios,
 * not bugs:
 *   - blast-radius file changed (package.json, tsconfig.json, …): full graph
 *     potentially affected, dep walk would miss it.
 *   - no metafile cache yet: nothing built before this run.
 *   - git failed: not a repo, ref doesn't exist, git binary missing.
 *
 * Always logs how the filter resolved (full / filtered / fallback) so users can
 * reason about why their selected suite ran.
 */
export async function getChangedFsTree(
  fsTree: FSTree,
  projectRoot: string,
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

  const cache = await MetafileCache.read(projectRoot);
  if (!cache) {
    process.stdout.write(
      `# --changed: no metafile cache yet — running all ${testFiles.length} test files (cache populates on this run)\n`,
    );
    return fsTree;
  }

  // Three outcomes, three named shapes: a declared failure, a successful "run everything"
  // scan, and a set of paths. This used to be one variable holding `Set | null | Error`,
  // discriminated by `instanceof` — with the `null` branch ("run everything") adjacent to the
  // `size === 0` branch ("run nothing").
  const scan = await getChanged(projectRoot, changedSince).result();
  if (!scan.ok) {
    process.stdout.write(
      `# --changed: ${scan.error.message} — running all ${testFiles.length} test files\n`,
    );
    return fsTree;
  } else if (scan.value.scope === 'everything') {
    process.stdout.write(
      `# --changed: blast-radius file changed (${scan.value.trigger}) — running all ${testFiles.length} test files\n`,
    );
    return fsTree;
  } else if (scan.value.paths.size === 0) {
    process.stdout.write(
      `# --changed: 0 files changed since ${changedSince} — running 0 test files\n`,
    );
    return {};
  }

  const affected = getChangedFiles(cache.metafile, cache.esbuildCwd, scan.value.paths, testFiles);
  process.stdout.write(
    `# --changed: ${affected.size} of ${testFiles.length} test files affected by changes since ${changedSince}\n`,
  );
  return Object.fromEntries(testFiles.filter((f) => affected.has(f)).map((f) => [f, null]));
}
