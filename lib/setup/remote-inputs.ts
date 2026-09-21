import path from 'node:path';
import * as Failure from '../result/failure.ts';

// Test files that live on a server rather than on this disk. `qunitx https://example.com/tests/`
// is the same run as `qunitx test/` — the files are fetched instead of read, and everything
// downstream (bundling, grouping, reporting) treats them as the paths they are.
//
// This module answers two questions and nothing else: which inputs are remote, and which URLs one
// of them means. Getting the bytes into a bundle is `remote-module-plugin.ts`.

/**
 * A remote input could not be fetched — refused, 404, or not something a module can be made of.
 *
 * ```ts
 * import { RemoteUnreadable } from './remote-inputs.ts';
 *
 * RemoteUnreadable({ url: 'https://x/a.js', why: '404 Not Found' }).message;
 * // 'could not read https://x/a.js — 404 Not Found'
 * ```
 */
export const RemoteUnreadable: Failure.FailureFactory<
  'RemoteUnreadable',
  { url: string; why: string }
> = Failure.define(
  'RemoteUnreadable',
  (data: { url: string; why: string }) => `could not read ${data.url} — ${data.why}`,
);

/** The one failure this module declares. */
export type RemoteUnreadableFailure = Failure.Of<typeof RemoteUnreadable>;

/** How long any single request is given before it is abandoned. */
const TIMEOUT_MS = 30_000;

/** How deep a `**` will walk a remote tree. Deep enough for a real suite, bounded for a loop. */
const MAX_DEPTH = 10;

/** How many URLs one glob may expand to, so a misdirected pattern cannot become the whole run. */
const MAX_MATCHES = 1_000;

/** The glob metacharacters, the same set `fs-tree` and `test-file-paths` test for. */
const GLOB_CHARS = /[*?{[]/;

/**
 * Whether an input names something on a server rather than on this disk.
 *
 * `http` and `https` only. A `file://` URL is a path spelled the long way and has no business
 * going through a fetch, and no other scheme has a body to bundle.
 *
 * ```ts
 * import { isRemoteInput } from './remote-inputs.ts';
 *
 * isRemoteInput('https://example.com/tests/cart-test.js'); // true
 * isRemoteInput('test/cart-test.ts'); // false
 * isRemoteInput('file:///tmp/a.ts'); // false — that is a path, and fs can read it
 * ```
 */
export function isRemoteInput(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

/**
 * The text at a URL, fetched once per `cache`.
 *
 * The cache is passed in rather than kept here, so its lifetime belongs to whoever owns the build:
 * a bundle fetches each module once however many times it is imported, and a fresh run fetches
 * again. A module-level cache would mean a `--watch` session never seeing a remote file change.
 *
 * Failures come back as {@link RemoteUnreadable} with the reason in words — `fetch` says
 * `TypeError: fetch failed` for a refused connection, a wrong host and an expired certificate
 * alike, and none of those three is helped by being told the other two are possible.
 *
 * ```ts
 * import { fetchRemote } from './remote-inputs.ts';
 *
 * // Defined, not invoked: it opens a socket.
 * function example() {
 *   return fetchRemote('https://example.com/tests/cart-test.js', new Map());
 * }
 * ```
 */
export async function fetchRemote(url: string, cache: Map<string, string>): Promise<string> {
  const held = cache.get(url);
  if (held !== undefined) return held;

  const response = await request(url);
  if (!response.ok) {
    throw RemoteUnreadable({ url, why: `${response.status} ${response.statusText}`.trim() });
  }
  const text = await response.text();
  // A URL with no module extension that answers in HTML is a PAGE — a bare origin, a directory
  // index, or a redirect to a login screen. Saying so names the input; letting it through gets
  // `Expected ";" but found "<"` from esbuild, pointing at a line of markup.
  if (looksLikeAPage(url, response.headers.get('content-type') ?? '')) {
    throw RemoteUnreadable({ url, why: 'it answers with a web page, not a module' });
  }
  cache.set(url, text);

  return text;
}

/** An HTML answer to a URL that never claimed to be a module — see {@link fetchRemote}. */
function looksLikeAPage(url: string, contentType: string): boolean {
  if (!contentType.toLowerCase().includes('html')) return false;
  const pathname = pathnameOf(url);

  return !/\.[cm]?[jt]sx?$|\.json$/i.test(pathname);
}

/**
 * Every URL a remote glob means.
 *
 * HTTP has no `readdir`, so a directory has to volunteer its contents. Two shapes are read,
 * because between them they cover every server anybody points this at:
 *
 *   - **JSON** — an array of names, an array of `{ name }` (which is what the GitHub contents API
 *     answers), or `{ files: [...] }`. A server that means to be listed says so this way.
 *   - **HTML** — the `<a href>` links of an autoindex, which is what nginx, Caddy, `python -m
 *     http.server` and every static host produce for free.
 *
 * `**` walks into subdirectories, bounded at {@link MAX_DEPTH} levels and {@link MAX_MATCHES}
 * files so that a pattern aimed at the wrong host cannot quietly become the whole run.
 *
 * The extension filter is the run's own: a directory listing is full of things that are not test
 * files, and the local walk filters the same way.
 *
 * ```ts
 * import { expandRemoteGlob } from './remote-inputs.ts';
 *
 * // Defined, not invoked: it lists a real server.
 * function example() {
 *   return expandRemoteGlob('https://example.com/tests/*-test.js', ['js', 'ts'], new Map());
 * }
 * ```
 */
export async function expandRemoteGlob(
  pattern: string,
  extensions: readonly string[],
  cache: Map<string, string>,
): Promise<string[]> {
  const base = staticPrefixOf(pattern);
  const deep = pattern.includes('**');
  const wanted = (url: string) =>
    extensions.some((extension) => pathnameOf(url).endsWith(`.${extension}`));

  const found: string[] = [];
  const seen = new Set<string>();

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (found.length >= MAX_MATCHES || depth > MAX_DEPTH || seen.has(directory)) return;
    seen.add(directory);

    const entries = await listDirectory(directory, cache);
    // Directories last and files first would still be one pass; the order here is the listing's,
    // and the sort at the end is what makes a run's file order stable rather than a server's.
    for (const entry of entries) {
      if (found.length >= MAX_MATCHES) return;
      if (entry.endsWith('/')) {
        if (deep) await walk(entry, depth + 1);
      } else if (wanted(entry) && path.posix.matchesGlob(entry, pattern)) {
        found.push(entry);
      }
    }
  };

  await walk(base, 0);

  return found.sort();
}

/**
 * Whether an input carries glob metacharacters — the same test the local walk makes.
 *
 * Its own export because a URL's query string is full of characters that look like a glob to a
 * casual regex, and the one place that decides this should be the one place anybody reads.
 *
 * ```ts
 * import { isRemoteGlob } from './remote-inputs.ts';
 *
 * isRemoteGlob('https://x/tests/*-test.js'); // true
 * isRemoteGlob('https://x/tests/a-test.js?v=2'); // false — a query is not a pattern
 * ```
 */
export function isRemoteGlob(input: string): boolean {
  const withoutQuery = input.split(/[?#]/)[0] ?? input;

  return GLOB_CHARS.test(withoutQuery);
}

/**
 * The recursive pattern a remote DIRECTORY input means, or `null` where the URL names a file.
 *
 * `qunitx test/` walks the tree under it, so `qunitx https://x/tests/` has to as well — and a
 * server cannot be asked which of the two it is. The same test `test-file-paths` already makes
 * decides it: a last segment with a dot in it is a file, and everything else is a directory.
 *
 * ```ts
 * import { remoteDirectoryPattern } from './remote-inputs.ts';
 *
 * remoteDirectoryPattern('https://x/tests/'); // 'https://x/tests/**'
 * remoteDirectoryPattern('https://x/tests'); // 'https://x/tests/**'
 * remoteDirectoryPattern('https://x/tests/a-test.js'); // null — that is a file
 * ```
 */
export function remoteDirectoryPattern(url: string): string | null {
  const withoutQuery = url.split(/[?#]/)[0] ?? url;
  const last = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
  if (last === '') return `${withoutQuery}**`;

  return last.includes('.') ? null : `${withoutQuery}/**`;
}

/**
 * The names one remote directory volunteers, as absolute URLs — directories keeping their
 * trailing slash, because that is the only thing that tells the walk which entries to descend.
 */
async function listDirectory(directory: string, cache: Map<string, string>): Promise<string[]> {
  const url = directory.endsWith('/') ? directory : `${directory}/`;
  const response = await request(url);
  if (!response.ok) {
    throw RemoteUnreadable({
      url,
      why: `${response.status} ${response.statusText}`.trim() || 'no listing',
    });
  }
  const type = response.headers.get('content-type') ?? '';
  const body = await response.text();
  cache.set(url, body);

  const names = type.includes('json') ? namesFromJSON(body, url) : namesFromLinks(body);

  return names.map((name) => new URL(name, url).href).filter((href) => href.startsWith(url));
}

/**
 * The names in a JSON listing: bare strings, `{ name }` objects (the GitHub contents API), or an
 * object wrapping either under `files`.
 *
 * A `{ type: 'dir' }` entry gets its slash back, because the walk reads directories off the slash
 * and an API that names its types should not have to be asked twice.
 */
function namesFromJSON(body: string, url: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw RemoteUnreadable({ url, why: 'its listing is not valid JSON' });
  }
  const entries = Array.isArray(parsed) ? parsed : ((parsed as { files?: unknown })?.files ?? null);
  if (!Array.isArray(entries)) {
    throw RemoteUnreadable({
      url,
      why: 'its JSON listing is neither an array nor `{ files: [] }`',
    });
  }

  return entries.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    const named = entry as { name?: unknown; type?: unknown };
    if (typeof named.name !== 'string') return [];

    return [named.type === 'dir' && !named.name.endsWith('/') ? `${named.name}/` : named.name];
  });
}

/**
 * The names in an HTML autoindex: every `<a href>` that is not the walk back up.
 *
 * Regex rather than a parser, as {@link findInternalAssetsFromHTML} already does here — an
 * autoindex is generated markup, and adding an HTML dependency to read a list of filenames would
 * cost more than it settles.
 */
function namesFromLinks(body: string): string[] {
  return [...body.matchAll(/<a[^>]+\bhref=['"]([^'"]+)['"]/gi)]
    .map((match) => match[1] as string)
    .filter((href) => href !== '' && href !== '../' && href !== '..' && !href.startsWith('?'));
}

/**
 * The directory a pattern starts from: everything up to the last `/` before the first glob
 * character. `https://x/tests/unit/*.js` starts at `https://x/tests/unit/`.
 */
function staticPrefixOf(pattern: string): string {
  const at = pattern.search(GLOB_CHARS);
  const head = at === -1 ? pattern : pattern.slice(0, at);
  const lastSlash = head.lastIndexOf('/');

  return head.slice(0, lastSlash + 1);
}

/** A URL's path, with the query and fragment off — what an extension test should be reading. */
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** One request, with a timeout and the failure said in words rather than as `fetch failed`. */
async function request(url: string): Promise<Response> {
  try {
    return await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw RemoteUnreadable({ url, why: saidOutLoud(error) });
  }
}

/**
 * A `fetch` failure in a sentence.
 *
 * `fetch` reports every one of these as `TypeError: fetch failed` with the cause buried, and a
 * host that resolves to both address families arrives as an AggregateError whose own message is
 * empty — so the code has to be dug out of the attempts inside it.
 */
function saidOutLoud(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `no answer within ${Math.round(TIMEOUT_MS / 1000)}s`;
  }
  const cause = (error as { cause?: unknown })?.cause;
  const attempts = (cause as { errors?: unknown[] })?.errors;
  const inner = Array.isArray(attempts) ? (attempts[0] ?? cause) : cause;
  const code = (inner as { code?: string })?.code;
  if (code !== undefined) return REFUSALS[code] ?? code;

  const said = ((inner as Error)?.message ?? (error as Error)?.message ?? String(error)).trim();

  return namedInWords(said) ?? (said === '' ? 'the request failed' : said);
}

/**
 * The same conditions as {@link REFUSALS}, recognised from a runtime that reports them only in
 * prose.
 *
 * Node attaches a `code` to the cause; Deno attaches nothing and puts one hyper sentence in the
 * message — `error sending request for url (…): client error (Connect): tcp connect error:
 * Connection refused (os error 111)`. That is all true and none of it is worth printing at a
 * prompt, so the condition is read out of the words and said the same way on both.
 *
 * And the words are the OPERATING SYSTEM's, not Deno's: on Windows the same refusal arrives as
 * `No connection could be made because the target machine actively refused it. (os error 10061)`,
 * which says "refused" without ever saying "connection refused". The Windows sentences are listed
 * beside the Unix ones for that reason.
 *
 * ```ts
 * import { namedInWords } from './remote-inputs.ts';
 *
 * namedInWords('tcp connect error: Connection refused (os error 111)'); // 'connection refused'
 * namedInWords('the target machine actively refused it. (os error 10061)'); // 'connection refused'
 * namedInWords('something nobody has named'); // null
 * ```
 */
export function namedInWords(message: string): string | null {
  const lowered = message.toLowerCase();
  for (const [phrase, said] of PHRASES) {
    if (lowered.includes(phrase)) return said;
  }

  return null;
}

/** Ordered, so the more specific phrase wins where two could match. */
const PHRASES: ReadonlyArray<readonly [string, string]> = [
  ['connection refused', 'connection refused'],
  // Windows, which words each of these its own way (WSAECONNREFUSED, WSAECONNRESET, …).
  ['actively refused', 'connection refused'],
  ['forcibly closed by the remote host', 'connection reset'],
  ['no such host is known', 'no such host'],
  ['did not properly respond after a period of time', 'connection timed out'],
  ['connection reset', 'connection reset'],
  ['failed to lookup address', 'no such host'],
  ['name or service not known', 'no such host'],
  ['dns error', 'no such host'],
  ['network is unreachable', 'host unreachable'],
  ['operation timed out', 'connection timed out'],
  ['certificate', 'the certificate was rejected'],
];

/** The socket errors worth saying in words, since their codes are not words. */
const REFUSALS: Readonly<Record<string, string>> = {
  ECONNREFUSED: 'connection refused',
  ENOTFOUND: 'no such host',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ETIMEDOUT: 'connection timed out',
  CERT_HAS_EXPIRED: 'the certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'a self-signed certificate',
};
