import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Failure from '../result/failure.ts';

// What `qunitx run` would bundle and execute. A URL that names one of these is a script too.
const SCRIPT_FILE = /\.(m?[jt]sx?|cjs|cts)$/i;
// A tour drives the browser from Node rather than running inside the page. It is one by its name,
// or by what it exports: `export default tour(…)` makes `shop.ts` as much a tour as `shop.tour.ts`.
const TOUR_FILE = /\.tour\.m?[jt]s$/i;
const TOUR_SOURCE = /\bexport\s+default\s+tour\s*\(/;
const PAGE_FILE = /\.html?$/i;
// A Markdown deck: slides separated by `---` lines.
const SLIDES_FILE = /\.(md|markdown)$/i;
// An image shown as a slide of its own.
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const URL_INPUT = /^(https?|file):\/\//i;

/**
 * A `qunitx record` input that is not there, or not something that can be recorded.
 *
 * ```ts
 * import { UnrecordableInput } from './inputs.ts';
 *
 * UnrecordableInput({ input: 'notes.txt', reason: 'not a page, a URL or a script' }).message;
 * // 'cannot record notes.txt: not a page, a URL or a script'
 * ```
 */
export const UnrecordableInput: Failure.FailureFactory<
  'UnrecordableInput',
  { input: string; reason: string }
> = Failure.define(
  'UnrecordableInput',
  (data: { input: string; reason: string }) => `cannot record ${data.input}: ${data.reason}`,
);

/**
 * One thing to record, resolved. `source` is the input as given; `name` is what its files are
 * called by default (`example.com` → `example.com.jpg`).
 *
 * - `url`: a page at an `http(s)://` URL, shown as it is once it has loaded.
 * - `html`: an HTML file on disk, served from `root`, its own directory, over a local origin so its
 *   relative assets and module scripts load as they would from a real server.
 * - `script`: a file `qunitx run` would execute, local or at a URL; what it draws while it runs
 *   is the recording.
 * - `tour`: a `.tour.ts` file, or a script whose default export is `tour(…)`, run in Node, driving
 *   the browser through the tour API.
 * - `slides`: a Markdown deck, a slide per `---`-separated part.
 * - `image`: a picture, shown as a slide: a file, or a URL to one.
 *
 * ```ts
 * const input: Input = { kind: 'url', source: 'https://example.com', url: 'https://example.com', name: 'example.com' };
 * input.name; // 'example.com' — what its default output file is called
 * ```
 */
export type Input =
  | { kind: 'url'; source: string; url: string; name: string }
  | { kind: 'html'; source: string; path: string; root: string; name: string }
  | { kind: 'script'; source: string; path: string; name: string }
  | { kind: 'tour'; source: string; path: string; name: string }
  | { kind: 'slides'; source: string; path: string; name: string }
  | {
      kind: 'image';
      source: string;
      /** A URL, or the absolute path of a file. */
      location: string;
      name: string;
    };

/**
 * Works out what each input is: a page to load or a script to run. Given a list, resolves every
 * one; given one source, that one.
 *
 * URLs are taken as they are — `https://`, `http://` and `file://` — unless they name a script
 * file, which runs as one, just as `qunitx run https://…/seed.ts` does. A path is resolved against
 * `cwd` and must exist: an `.html` file or a directory with an `index.html` is a page, a
 * `.tour.ts` file or a script that does `export default tour(…)` is a tour, and any other
 * `.js`/`.ts`/`.jsx`/`.tsx` file is a script.
 *
 * ```ts
 * import { resolve } from './inputs.ts';
 *
 * const [page] = await resolve(['https://example.com/docs/'], '/tmp');
 * page.kind; // 'url'
 * page.name; // 'example.com-docs'
 * ```
 */
export function resolve(sources: string[], cwd: string): Promise<Input[]>;
/**
 * One source, resolved as each one in a list is.
 *
 * ```ts
 * import { resolve } from './inputs.ts';
 *
 * (await resolve('https://example.com/', '/tmp')).name; // 'example.com'
 * ```
 */
export function resolve(source: string, cwd: string): Promise<Input>;
export async function resolve(source: string | string[], cwd: string): Promise<Input | Input[]> {
  if (Array.isArray(source)) {
    return await Promise.all(source.map((one) => resolve(one, cwd)));
  } else if (URL_INPUT.test(source)) {
    const url = new URL(source);
    if (url.protocol === 'file:') return await resolve(fileURLToPath(url), cwd);
    else if (SCRIPT_FILE.test(url.pathname)) {
      return { kind: 'script', source, path: source, name: generateFileNameFromURL(url) };
    } else if (IMAGE_FILE.test(url.pathname)) {
      return { kind: 'image', source, location: source, name: generateFileNameFromURL(url) };
    }
    return { kind: 'url', source, url: source, name: generateFileNameFromURL(url) };
  }

  const absolute = path.resolve(cwd, source);
  const entry = await stat(absolute).catch(() => null);
  if (!entry) throw UnrecordableInput({ input: source, reason: 'no such file or directory' });
  if (entry.isDirectory()) {
    const index = path.join(absolute, 'index.html');
    if (!(await stat(index).catch(() => null))?.isFile()) {
      throw UnrecordableInput({ input: source, reason: 'a directory with no index.html' });
    }
    return buildHTMLInput(source, index, path.basename(absolute));
  } else if (PAGE_FILE.test(absolute)) {
    return buildHTMLInput(source, absolute, path.basename(absolute).replace(PAGE_FILE, ''));
  } else if (SLIDES_FILE.test(absolute)) {
    return {
      kind: 'slides',
      source,
      path: absolute,
      name: path.basename(absolute).replace(SLIDES_FILE, ''),
    };
  } else if (IMAGE_FILE.test(absolute)) {
    return {
      kind: 'image',
      source,
      location: absolute,
      name: path.basename(absolute).replace(IMAGE_FILE, ''),
    };
  } else if (TOUR_FILE.test(absolute)) {
    return {
      kind: 'tour',
      source,
      path: absolute,
      name: path.basename(absolute).replace(TOUR_FILE, ''),
    };
  } else if (SCRIPT_FILE.test(absolute)) {
    return {
      kind: TOUR_SOURCE.test(await readFile(absolute, 'utf8')) ? 'tour' : 'script',
      source,
      path: absolute,
      name: path.basename(absolute).replace(SCRIPT_FILE, ''),
    };
  }
  throw UnrecordableInput({
    input: source,
    reason:
      'not an .html page, a URL, a .js/.ts/.jsx/.tsx script, a .tour.ts tour, a .md deck or an image',
  });
}

// An HTML file on disk as a page: served from its own directory, so its relative assets load.
function buildHTMLInput(givenSource: string, htmlPath: string, targetFileName: string): Input {
  return {
    kind: 'html',
    source: givenSource,
    path: htmlPath,
    root: path.dirname(htmlPath),
    name: targetFileName,
  };
}

/**
 * The file name a URL is recorded under by default: its host and path, with anything that is not
 * safe in a file name collapsed to `-`.
 *
 * ```ts
 * import { generateFileNameFromURL } from './inputs.ts';
 *
 * generateFileNameFromURL(new URL('https://example.com/')); // 'example.com'
 * generateFileNameFromURL(new URL('http://localhost:4200/users/1?tab=a')); // 'localhost-4200-users-1-tab-a'
 * ```
 */
export function generateFileNameFromURL(url: URL): string {
  const name = `${url.host}${url.pathname}${url.search}`
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name || 'page';
}

/**
 * The full URL `file` loads from once `servedRoot`, a directory it is in, is served at `origin`.
 *
 * ```ts
 * import { getFullURLOf } from './inputs.ts';
 *
 * getFullURLOf('/site/docs/a b.html', 'http://localhost:1234', '/site'); // 'http://localhost:1234/docs/a%20b.html'
 * ```
 */
export function getFullURLOf(file: string, origin: string, servedRoot: string): string {
  const segments = path.relative(servedRoot, file).split(path.sep).map(encodeURIComponent);
  return new URL(`/${segments.join('/')}`, origin).href;
}
