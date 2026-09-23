import http from 'node:http';

/** How a directory volunteers its contents — the three shapes a real server has. */
export type IndexStyle = 'html' | 'json' | 'json-objects' | 'none';

/**
 * A server that answers with the files it is given, and lists its directories the way a real one
 * does — so a test can point `qunitx` at a URL and get the same answer a person would.
 *
 * Files are an in-memory map of pathname to contents, which is both faster than a temp directory
 * and easier to read: the fixture and the assertion sit in the same test.
 *
 * `index` picks how a directory lists itself, because the whole point of remote globbing is that
 * different servers do it differently:
 *
 * ```
 * html          an autoindex of <a href> links — nginx, Caddy, `python -m http.server`
 * json          a JSON array of names
 * json-objects  a JSON array of { name, type } — the shape the GitHub contents API answers
 * none          404 on a directory, which is a server that will not be listed
 * ```
 *
 * `types` overrides what a path is served AS, which is the only way to build the two cases the
 * content-type guard exists for: a `.js` a server calls HTML, and a directory whose JSON listing
 * will not parse.
 *
 * `requests` records every pathname asked for, in order, so a test can prove a module was
 * fetched once rather than once per importer.
 *
 * ```ts
 * import { staticServer } from './static-server.ts';
 *
 * // Defined, not invoked: it binds a port.
 * async function example() {
 *   await using server = await staticServer({ files: { '/a.js': 'export const a = 1;' } });
 *
 *   return `${server.url}/a.js`;
 * }
 * ```
 */
export async function staticServer(
  options: {
    files?: Record<string, string>;
    index?: IndexStyle;
    types?: Record<string, string>;
  } = {},
): Promise<{ url: string; requests: string[] } & AsyncDisposable> {
  const files = options.files ?? {};
  const style = options.index ?? 'html';
  const types = options.types ?? {};
  const requests: string[] = [];

  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    requests.push(pathname);

    // A directory serves its `index.html`, which is what every real server does and what makes
    // `/test/` a page rather than a listing. The content type follows the file actually served,
    // not the path asked for: `/test/` typed as text/javascript is a page Chrome never renders.
    // …and a directory asked for without its slash redirects, as every real server does: the
    // page's own `./runtime.js` resolves against `/test/`, and against `/test` it would 404.
    if (files[pathname] === undefined && files[`${pathname}/index.html`] !== undefined) {
      response.writeHead(301, { location: `${pathname}/` });

      return void response.end();
    }
    const served =
      files[pathname] === undefined ? `${pathname.replace(/\/$/, '')}/index.html` : pathname;
    const contents = files[served];
    if (contents !== undefined) {
      response.writeHead(200, {
        'content-type': types[pathname] ?? types[served] ?? contentTypeOf(served),
      });

      return void response.end(contents);
    }
    const directory = pathname.endsWith('/') ? pathname : `${pathname}/`;
    const entries = childrenOf(files, directory);
    if (entries.length === 0 || style === 'none') {
      response.writeHead(404, { 'content-type': 'text/plain' });

      return void response.end('nope');
    }
    const [body, type] = listing(entries, style);
    response.writeHead(200, { 'content-type': type });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The immediate children of a directory: files by name, subdirectories with their trailing slash.
 *
 * Immediate, not transitive — a listing that showed grandchildren would let a broken recursive
 * walk pass, which is the one thing these tests are for.
 */
function childrenOf(files: Record<string, string>, directory: string): string[] {
  const names = new Set<string>();
  for (const pathname of Object.keys(files)) {
    if (!pathname.startsWith(directory)) continue;
    const rest = pathname.slice(directory.length);
    const slash = rest.indexOf('/');
    names.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
  }

  return [...names].sort();
}

/** One listing, in whichever shape this server was asked to speak. */
function listing(entries: readonly string[], style: IndexStyle): [string, string] {
  if (style === 'json') return [JSON.stringify(entries), 'application/json'];
  else if (style === 'json-objects') {
    const described = entries.map((name) =>
      name.endsWith('/') ? { name: name.slice(0, -1), type: 'dir' } : { name, type: 'file' },
    );

    return [JSON.stringify(described), 'application/json'];
  }
  // The `../` link every autoindex emits is deliberately present: skipping it is the walk's job,
  // and a fixture without one would never prove that it does.
  const links = entries.map((name) => `<a href="${name}">${name}</a>`).join('\n');

  return [`<html><body><a href="../">../</a>\n${links}</body></html>`, 'text/html'];
}

/** What a server would call each of these. Deliberately plain — the loader reads the name. */
function contentTypeOf(pathname: string): string {
  if (pathname.endsWith('.json')) return 'application/json';
  else if (pathname.endsWith('.html')) return 'text/html';
  else if (pathname.endsWith('.css')) return 'text/css';

  return 'text/javascript';
}
