import type { BuildState } from '../../types.ts';

/**
 * Drops both cached bundles so the next re-run rebuilds from disk.
 *
 * Both must go together: `/tests.js` serves `allTestCode` and `/filtered-tests.js` serves
 * `filteredTestCode` verbatim, so clearing only the former leaves a stale filtered bundle
 * servable — and a watch-mode delete would rerun tests from a file that no longer exists.
 */
export function clearCachedBundles(build: BuildState): void {
  build.allTestCode = null;
  build.filteredTestCode = undefined;
}
