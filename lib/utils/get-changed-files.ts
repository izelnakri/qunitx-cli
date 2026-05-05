import path from 'node:path';

/**
 * Subset of esbuild's Metafile shape that we actually read. Defined locally so
 * this module doesn't import the heavy `esbuild` package — it only parses a
 * JSON file that esbuild produced earlier.
 */
export interface AffectedMetafile {
  /** Every input file esbuild visited, keyed by path relative to esbuild's cwd. */
  inputs: Record<string, { imports?: Array<{ path: string }> }>;
}

/**
 * Returns the subset of `testFiles` (absolute paths) whose transitive imports,
 * per the cached esbuild metafile, include any file in `changedAbsPaths`.
 *
 * Memoizes "does this node transitively reach a changed file?" across all tests
 * so total work is O(V+E) for the whole call, regardless of how many tests
 * share dependencies. Cycles are handled by tracking the active recursion stack.
 *
 * Paths in the metafile are relative to `esbuildCwd`; we resolve them against it
 * so comparisons happen on normalized absolute paths.
 */
export function getChangedFiles(
  metafile: AffectedMetafile,
  esbuildCwd: string,
  changedAbsPaths: ReadonlySet<string>,
  testFiles: readonly string[],
): Set<string> {
  // absolute-path → absolute-paths-of-imports. One pass over the metafile
  // up front; subsequent reachability lookups are O(1) per node.
  const deps = new Map(
    Object.entries(metafile.inputs).map(([relPath, info]) => [
      path.resolve(esbuildCwd, relPath),
      (info.imports ?? []).map((i) => path.resolve(esbuildCwd, i.path)),
    ]),
  );

  const memo = new Map<string, boolean>();
  return new Set(
    testFiles.filter((test) => reachesChange(test, deps, changedAbsPaths, memo, new Set())),
  );
}

function reachesChange(
  node: string,
  deps: Map<string, string[]>,
  changedAbsPaths: ReadonlySet<string>,
  memo: Map<string, boolean>,
  stack: Set<string>,
): boolean {
  const cached = memo.get(node);
  if (cached !== undefined) return cached;
  // Cycle: this branch contributes no new info; let other branches decide.
  // Don't memoize here — the answer depends on which branch eventually closes.
  if (stack.has(node)) return false;
  stack.add(node);
  // `.some` short-circuits exactly like a for-loop with break, so the
  // memoized DFS preserves its O(V+E) total bound across all tests.
  const result =
    changedAbsPaths.has(node) ||
    (deps.get(node) ?? []).some((dep) => reachesChange(dep, deps, changedAbsPaths, memo, stack));
  stack.delete(node);
  memo.set(node, result);
  return result;
}
