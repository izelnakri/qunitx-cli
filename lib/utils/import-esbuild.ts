// Loads esbuild on first use rather than at module load.
//
// esbuild is what bundles a run — but a `--no-bundle` run serves the test files to the browser as
// they are, through an import map, and never needs it. Importing it lazily is what lets such a
// run start on a machine where esbuild was never installed (`npm install --omit=optional`, a
// locked-down CI image, a platform esbuild ships no binary for), and keeps its ~20ms module load
// off every run that does not bundle.

type Esbuild = typeof import('esbuild');

let loading: Promise<Esbuild | null> | null = null;

/**
 * esbuild, or `null` when it is not installed. Memoized — the import is attempted once per
 * process, and every later caller shares that answer.
 *
 * Only a missing package reads as `null`. An esbuild that is installed but broken (a binary for
 * the wrong platform, a version mismatch between the JS and the native service) still throws, so
 * that failure is reported as itself rather than as "not installed".
 *
 * ```ts
 * import { tryImportEsbuild } from './import-esbuild.ts';
 *
 * // Defined, not invoked: the first call loads esbuild's JS API.
 * async function canBundle() {
 *   return (await tryImportEsbuild()) !== null;
 * }
 * ```
 */
export function tryImportEsbuild(): Promise<Esbuild | null> {
  loading ??= import('esbuild').then(
    (mod) => ((mod as { default?: Esbuild }).default ?? mod) as Esbuild,
    (error) => {
      if (isMissingPackage(error)) return null;
      throw error;
    },
  );

  return loading;
}

/**
 * esbuild, for a feature that cannot work without it. Throws {@link EsbuildMissingError} — which
 * names the feature and the way out — when it is not installed.
 *
 * ```ts
 * import { importEsbuild } from './import-esbuild.ts';
 *
 * // Defined, not invoked: rejects with an actionable message when esbuild is absent.
 * async function transpile(source: string) {
 *   const esbuild = await importEsbuild('JSX in a --no-bundle run');
 *   return (await esbuild.transform(source, { loader: 'jsx' })).code;
 * }
 * ```
 */
export async function importEsbuild(feature: string): Promise<Esbuild> {
  const esbuild = await tryImportEsbuild();
  if (!esbuild) throw new EsbuildMissingError(feature);

  return esbuild;
}

/**
 * Thrown by {@link importEsbuild} when esbuild is not installed. The message is the whole fix.
 *
 * ```ts
 * import { EsbuildMissingError } from './import-esbuild.ts';
 *
 * new EsbuildMissingError('bundling').message.startsWith('bundling needs esbuild'); // true
 * ```
 */
export class EsbuildMissingError extends Error {
  /** `feature` opens the message: what was about to need esbuild ("Bundling the tests"). */
  constructor(feature: string) {
    super(
      `${feature} needs esbuild, which is not installed. Install it (\`npm install --save-dev esbuild\`), ` +
        'or run with --no-bundle to load the test files natively through an import map.',
    );
    this.name = 'EsbuildMissingError';
  }
}

function isMissingPackage(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  // Node says ERR_MODULE_NOT_FOUND; Deno's npm resolver and some loaders only say it in words.
  return (
    code === 'ERR_MODULE_NOT_FOUND' ||
    code === 'MODULE_NOT_FOUND' ||
    /cannot find (module|package) ['"]?esbuild/i.test(String((error as Error)?.message))
  );
}
