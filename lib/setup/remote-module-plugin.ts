import { RemoteUnreadable, fetchRemote } from './remote-inputs.ts';
import type { Loader, Plugin } from 'esbuild';

/**
 * The esbuild namespace a fetched module lives in. Exported so a plugin that RESOLVES an entry
 * itself — `qunitx run`'s, which hands esbuild a path rather than a specifier — can mark a URL as
 * belonging here; a plain path would otherwise be looked for on this disk.
 *
 * ```ts
 * import { REMOTE_NAMESPACE } from './remote-module-plugin.ts';
 *
 * REMOTE_NAMESPACE; // 'qunitx-remote'
 * ```
 */
export const REMOTE_NAMESPACE = 'qunitx-remote';

/**
 * esbuild plugin that lets a bundle reach modules served over HTTP, so
 * `qunitx https://example.com/tests/cart-test.js` runs the same way a local path does.
 *
 * Three rules, which together are the whole of it:
 *
 *   - An absolute `http(s)` specifier — an entry point, or an import inside any module — is
 *     claimed here.
 *   - Inside a remote module, a RELATIVE specifier resolves against the importing URL, which is
 *     how a browser and every ES module loader already resolve one. `./helpers.js` beside a
 *     remote test is the file beside it on that server.
 *   - Inside a remote module, anything else — `qunitx`, `lodash` — resolves LOCALLY, against this
 *     project's `node_modules`. A remote test importing `qunitx` means the runtime that is about
 *     to run it, not a package it hopes the server also happens to host.
 *
 * Each module is fetched once per plugin instance, which is once per build. The cache lives here
 * rather than in the module so a `--watch` session gets fresh bytes on its next build instead of
 * serving a remote file that has since changed.
 *
 * ```ts
 * import { remoteModulePlugin } from './remote-module-plugin.ts';
 *
 * remoteModulePlugin('/proj').name; // 'qunitx-remote-module'
 * ```
 */
export function remoteModulePlugin(cwd: string = process.cwd()): Plugin {
  const cache = new Map<string, string>();

  return {
    name: 'qunitx-remote-module',
    setup(build) {
      build.onResolve({ filter: /^https?:\/\//i }, (args) => ({
        path: args.path,
        namespace: REMOTE_NAMESPACE,
      }));

      build.onResolve({ filter: /.*/, namespace: REMOTE_NAMESPACE }, async (args) => {
        if (/^\.{0,2}\//.test(args.path)) {
          return { path: new URL(args.path, args.importer).href, namespace: REMOTE_NAMESPACE };
        }
        // A bare specifier goes back through the normal resolver — `resolveDir` is this project,
        // not the server, so the `qunitx` a remote test imports is the one running it. Any other
        // plugin's `onResolve` (the embedded-runtime fallback included) sees it on the way.
        return await build.resolve(args.path, { kind: args.kind, resolveDir: cwd });
      });

      build.onLoad({ filter: /.*/, namespace: REMOTE_NAMESPACE }, async (args) => ({
        contents: await fetchRemote(args.path, cache),
        loader: loaderFor(args.path),
        // Where a relative import inside this module would resolve if it escaped the namespace,
        // and where esbuild looks for a tsconfig. Neither should be a directory on the server.
        resolveDir: cwd,
      }));
    },
  };
}

/**
 * Which loader a URL's extension asks for.
 *
 * Extension rather than content type, because a server's idea of what JavaScript is called varies
 * and a filename's does not — and an extensionless URL is JavaScript far more often than it is
 * anything else, which is the same guess a browser makes.
 *
 * An extension that is plainly not a module is refused BY NAME. esbuild's own answer is
 * `No loader is configured for ".html" files`, which does not say which of the run's inputs it
 * came from.
 *
 * ```ts
 * import { loaderFor } from './remote-module-plugin.ts';
 *
 * loaderFor('https://x/a-test.ts'); // 'ts'
 * loaderFor('https://x/a-test.js?v=2'); // 'js' — a query is not an extension
 * loaderFor('https://x/api/tests'); // 'js'
 * ```
 */
export function loaderFor(url: string): Loader {
  const pathname = safePathname(url);
  const extension = pathname.slice(pathname.lastIndexOf('.') + 1).toLowerCase();
  const loader = LOADERS[extension];
  if (loader !== undefined) return loader;
  else if (REFUSED.has(extension)) {
    throw RemoteUnreadable({ url, why: `a .${extension} file is not a module` });
  }

  return 'js';
}

/** The extensions a test file is actually written in, plus the two a test file imports. */
const LOADERS: Readonly<Record<string, Loader>> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  json: 'json',
  css: 'css',
  txt: 'text',
};

/** Extensions worth refusing by name, because they are what somebody points at by mistake. */
const REFUSED: ReadonlySet<string> = new Set(['html', 'htm', 'xml', 'pdf', 'zip', 'png', 'jpg']);

/** A URL's path, with query and fragment off; the string itself where it will not parse. */
function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}
