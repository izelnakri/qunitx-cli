import type { Plugin } from 'esbuild';
import { readTemplate } from '../utils/read-template.ts';

const NAMESPACE = 'qunitx-runtime';

/**
 * esbuild plugin that lets test files `import { module, test } from 'qunitx'` even when the
 * consumer project has NOT installed the separate `qunitx` runtime package — the case for
 * JSR/standalone-binary/npx users, who have no `node_modules` at all.
 *
 * A consumer-installed qunitx still wins: `onResolve` runs esbuild's own resolver first and only
 * falls back to the embedded, pre-bundled runtime when that fails. The runtime is read in-process
 * via {@link readTemplate} (SEA `getAsset` / deno-VFS fs) and handed to esbuild as in-memory
 * `contents`, because the native esbuild sidecar process cannot read SEA-store or deno-VFS files.
 *
 * Scoped to the bare `qunitx` specifier only (covers the generated tests + documented usage);
 * `qunitx/assert` — used by advanced consumers extending asserts — is not yet provided as a
 * fallback (its default export collides with the runtime's, needing a separate bundle).
 */
export function qunitxRuntimePlugin(): Plugin {
  return {
    name: 'qunitx-runtime',
    setup(build) {
      build.onResolve({ filter: /^qunitx$/ }, async (args) => {
        // build.resolve re-enters onResolve; the pluginData flag makes that pass defer to the
        // default resolver instead of recursing back into this handler.
        if (args.pluginData?.qunitxRuntimeResolving) return null;
        const resolved = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: { qunitxRuntimeResolving: true },
        });
        // Honor a consumer-installed qunitx when present; otherwise serve the embedded runtime.
        if (resolved.errors.length === 0 && resolved.path) return resolved;
        return { path: args.path, namespace: NAMESPACE };
      });

      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async () => ({
        contents: await readTemplate('vendor/qunitx-runtime.js'),
        loader: 'js',
        resolveDir: process.cwd(),
      }));
    },
  };
}
