import { createRequire } from 'node:module';
import { join } from 'node:path';

// esbuild, playwright-core and ws are `external` in the dist bundle, so the SEA carries the
// import statements but not the packages.
export const SEA_EXTERNALS = ['playwright-core', 'esbuild', 'ws'];

/**
 * Whether a Node SEA launched in `cwd` would be able to load the runner's external dependencies.
 *
 * A SEA has no path of its own, so Node resolves the bundle's bare specifiers against the current
 * directory instead of against the installation. When qunitx is installed globally and run in a
 * project that does not itself depend on it, nothing answers them and the run dies on the first
 * one it reaches — `Cannot find package 'playwright-core' imported from <cwd>`. The bundle's
 * imports are static, so there is nothing to redirect at runtime; the only honest question is
 * whether this directory can satisfy them at all.
 *
 * Own file, and exported, because it is the whole of the decision and the bin script cannot be
 * imported to test it — importing it runs the CLI.
 *
 * ```js
 * canUseSea('/tmp/a-project-with-no-node-modules'); // false — fall back to dist/cli.js
 * ```
 */
export function canUseSea(cwd) {
  // A file inside `cwd`, because createRequire resolves relative to a *module*, not a directory.
  const fromCwd = createRequire(join(cwd, 'noop.js'));

  return SEA_EXTERNALS.every((name) => {
    try {
      fromCwd.resolve(name);
      return true;
    } catch {
      return false;
    }
  });
}
