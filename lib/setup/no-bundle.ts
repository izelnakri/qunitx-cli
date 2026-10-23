import fs from 'node:fs/promises';
import path from 'node:path';
import * as ImportMap from './import-map.ts';
import { isTransformed, transform } from '../utils/transform-source.ts';
import { readTemplate } from '../utils/read-template.ts';
import { MIME_TYPES } from '../web/index.ts';
import type { HTTPServer, Request, Response } from '../web/index.ts';
import type { AffectedMetafile } from '../utils/get-changed-files.ts';
import type { ServedModule, SourceMapDecoder } from '../utils/source-map.ts';

/**
 * Everything a `--no-bundle` run shares across its groups: the import map every page carries, the
 * modules the server has handed out (for stack traces and coverage), and the import graph the
 * browser walked (for `--changed`).
 *
 * ```ts
 * import * as NoBundle from './no-bundle.ts';
 *
 * const state: NoBundle.NoBundleState = NoBundle.createState('/proj', {
 *   importMap: { imports: { qunitx: '/@qunitx/runtime.js' }, scopes: {} },
 *   roots: ['/proj'],
 * });
 * state.modules.size; // 0 — filled as the browser requests modules
 * ```
 */
export interface NoBundleState {
  /** Paths in load errors are shown relative to it. */
  projectRoot: string;
  /** The map every page of the run carries. */
  importMap: ImportMap.ImportMap;
  /** Real paths of the directories modules may be served from. */
  roots: string[];
  /** Every module served, by URL pathname. Read by stack-trace resolution and coverage. */
  modules: Map<string, ServedModule>;
  /** importer → imported, absolute paths, as the browser requested them (from `Referer`). */
  edges: Map<string, Set<string>>;
  /**
   * Why a module could not be served, since the last entry was built — keyed by the reason, so a
   * module requested twice is reported once. Read by the page when a test file fails to load.
   */
  loadErrors: Map<string, LoadError>;
  /** Transform results by absolute path, reused while the file's mtime and size are unchanged. */
  transforms: Map<string, { stamp: string; served: ServedModule; contentType: string }>;
}

/**
 * A module the server could not serve: the file asked for, the module that asked, and why.
 *
 * ```ts
 * import type { LoadError } from './no-bundle.ts';
 *
 * const error: LoadError = { file: '/proj/lib/a', importer: '/proj/test/a-test.ts', reason: 'cannot find lib/a' };
 * error.importer; // '/proj/test/a-test.ts' — whose load failure this explains
 * ```
 */
export interface LoadError {
  /** The file that was asked for. */
  file: string;
  /** The module that asked for it, or `null` when it was the entry itself. */
  importer: string | null;
  /** What the page shows: the reason, with the importer named. */
  reason: string;
}

const JAVASCRIPT_CONTENT_TYPE = 'text/javascript; charset=utf-8';

// A TS project writes `import './util.js'` for `util.ts` (that is what `moduleResolution:
// nodenext` requires), so a missing `.js` is looked for under the TypeScript extensions first.
const SOURCE_FOR_OUTPUT: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
  '.jsx': ['.tsx'],
};
const EXTENSION_GUESSES = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '/index.ts', '/index.js'];

/**
 * Creates the shared state from a resolved import map.
 *
 * ```ts
 * import * as NoBundle from './no-bundle.ts';
 *
 * const state = NoBundle.createState('/proj', { importMap: { imports: {}, scopes: {} }, roots: ['/proj'] });
 * state.loadErrors.size; // 0
 * ```
 */
export function createState(
  projectRoot: string,
  resolved: ImportMap.ResolvedImportMap,
): NoBundleState {
  return {
    projectRoot,
    importMap: resolved.importMap,
    roots: resolved.roots,
    modules: new Map(),
    edges: new Map(),
    loadErrors: new Map(),
    transforms: new Map(),
  };
}

/**
 * Builds the shared state for a project: resolves its import map (see {@link ImportMap.build}).
 *
 * ```ts
 * import * as NoBundle from './no-bundle.ts';
 *
 * // Defined, not invoked: walks the project's node_modules.
 * async function example() {
 *   return (await NoBundle.setup('/proj')).importMap.imports.qunitx;
 * }
 * ```
 */
export async function setup(projectRoot: string): Promise<NoBundleState> {
  return createState(projectRoot, await ImportMap.build(projectRoot));
}

/**
 * The page's entry module — what `/tests.js` serves in place of a bundle. It preloads every test
 * file's module graph in parallel, then evaluates the files one at a time in order, so tests
 * register in the same order a bundle would register them.
 *
 * A file that fails to load (a typo'd import, a syntax error, a package missing from the import
 * map) does not take the run down with it: it becomes one failing test named after the file,
 * carrying the reasons the server recorded for that file's own import graph, and every other
 * file still runs.
 *
 * ```ts
 * import * as NoBundle from './no-bundle.ts';
 *
 * const entry = NoBundle.entrySource(['/proj/test/a-test.ts'], '/proj');
 * entry.includes('"/@fs/proj/test/a-test.ts"'); // true
 * entry.includes('qunitx:tests-ready'); // true — the runtime starts QUnit on this event
 * ```
 */
export function entrySource(files: string[], projectRoot: string): string {
  const entries = files.map((file) => [
    ImportMap.toFsUrl(file),
    path.relative(projectRoot, file).replaceAll('\\', '/'),
  ]);

  return `// qunitx --no-bundle entry: the test files, loaded by the browser through the page's import map.
const files = ${JSON.stringify(entries)};
for (const [url] of files) {
  const link = document.createElement('link');
  link.rel = 'modulepreload';
  link.href = url;
  document.head.append(link);
}
for (const [url, label] of files) {
  try {
    await import(url);
  } catch (error) {
    await reportLoadFailure(url, label, error);
  }
}
window.dispatchEvent(new CustomEvent('qunitx:tests-ready'));

async function reportLoadFailure(url, label, error) {
  // The server's reasons are the precise ones ("cannot find lib/a — did you mean a.ts?"); the
  // browser's own message is all there is when the server never saw the request — an unmapped
  // bare specifier is rejected before anything is fetched.
  const recorded = await fetch('${LOAD_ERRORS_URL}?for=' + encodeURIComponent(url))
    .then((response) => response.json(), () => []);
  const browserMessage = String((error && error.message) || error);
  const message = recorded.length > 0 ? recorded.join('\\n') : browserMessage + hintFor(browserMessage);
  const QUnit = window.QUnit && window.QUnit.version ? window.QUnit : (await import('qunitx')).default;
  QUnit.module(label);
  QUnit.test('loads without errors', (assert) => {
    assert.pushResult({ result: false, actual: null, expected: null, message });
  });
}

function hintFor(message) {
  // Chrome: 'Failed to resolve module specifier', Firefox: 'was a bare specifier, but was not
  // remapped', WebKit: 'does not resolve to a valid URL'.
  if (/module specifier|not remapped|does not resolve/i.test(message)) {
    return '\\nA bare import must be in the import map: add the package to package.json, or map it in package.json#qunitx.importMap.';
  }
  // Chrome: "does not provide an export named", Firefox: "doesn't provide an export named",
  // WebKit: "importing binding name 'x' is not found" — the shape of a CommonJS package.
  const commonjs = /module '([^']+)' (?:does not|doesn't) provide an export named|binding name '[^']+' is not found/i.exec(message);
  if (commonjs) {
    return '\\n' + (commonjs[1] ? "'" + commonjs[1] + "'" : 'The imported package') +
      ' is probably CommonJS, which a browser cannot import natively. Map it to an ESM build in package.json#qunitx.importMap (e.g. https://esm.sh/<package>), or run with --bundle.';
  }
  return '';
}
`;
}

/**
 * The tags that turn a page into a `--no-bundle` test page, in the order they must run: the import
 * map (a browser ignores one that arrives after the first module), the reporting runtime, QUnit's
 * preconfig, then the entry as a module.
 *
 * `autostart: false` has to be preconfigured here, where a bundle never needed it. A bundled
 * QUnit evaluates before the page's `load` event and qunitx turns autostart off in time; a module
 * graph imported from a top-level `await` evaluates after it, and QUnit — seeing the page already
 * loaded — would start itself before a single test registered.
 *
 * ```ts
 * import * as NoBundle from './no-bundle.ts';
 *
 * const tags = NoBundle.scriptTags({ imports: { a: '/a.js' }, scopes: {} }, '<script></script>', './tests.js');
 * tags.startsWith('<script type="importmap">'); // true
 * tags.endsWith('<script type="module" src="./tests.js"></script>'); // true
 * ```
 */
export function scriptTags(
  importMap: ImportMap.ImportMap,
  runtimeScript: string,
  entryUrl: string,
): string {
  // `<` escaped so a specifier holding `</script>` cannot close the tag early.
  const json = JSON.stringify(importMap).replaceAll('<', '\\u003c');

  return [
    `<script type="importmap">${json}</script>`,
    runtimeScript,
    '<script>(window.QUnit = window.QUnit || { config: {} }).config.autostart = false;</script>',
    `<script type="module" src="${entryUrl}"></script>`,
  ].join('\n');
}

/**
 * A decoder for a `--no-bundle` page: no bundle segments of its own, but every module the server
 * has served, so stack frames and coverage resolve per module.
 *
 * ```ts
 * import * as NoBundle from './no-bundle.ts';
 *
 * const state = NoBundle.createState('/proj', { importMap: { imports: {}, scopes: {} }, roots: ['/proj'] });
 * NoBundle.decoder(state, '/proj/tmp').modules === state.modules; // true
 * ```
 */
export function decoder(state: NoBundleState, outDir: string): SourceMapDecoder {
  return {
    segmentsByLine: [],
    sources: [],
    sourceRoot: '',
    outDir,
    sourcesContent: [],
    modules: state.modules,
  };
}

/**
 * The import graph the browser walked, in esbuild's metafile shape, so `--changed` works the same
 * on a run that never bundled. Paths are relative to `cwd`, as esbuild writes them.
 *
 * ```ts
 * import * as NoBundle from './no-bundle.ts';
 *
 * const state = NoBundle.createState('/proj', { importMap: { imports: {}, scopes: {} }, roots: ['/proj'] });
 * state.edges.set('/proj/test/a-test.ts', new Set(['/proj/lib/a.ts']));
 * NoBundle.metafile(state, '/proj');
 * // { inputs: { 'test/a-test.ts': { imports: [{ path: 'lib/a.ts' }] } } }
 * ```
 */
export function metafile(state: NoBundleState, cwd: string): AffectedMetafile {
  const relative = (file: string) => path.relative(cwd, file);

  return {
    inputs: Object.fromEntries(
      [...state.edges].map(([importer, imported]) => [
        relative(importer),
        { imports: [...imported].map((file) => ({ path: relative(file) })) },
      ]),
    ),
  };
}

/** Where the page asks why a module failed to load. */
const LOAD_ERRORS_URL = '/@qunitx/load-errors';

/**
 * Registers the routes a `--no-bundle` page loads its modules from: `/@fs/*` (any file under the
 * run's roots, TypeScript type-stripped on the way out), the embedded qunitx runtime, and the
 * load-error report the entry reads when an import fails.
 *
 * `extraRoots` widens the served directories at request time — the test files' own directories,
 * which change as watch mode adds files and can sit outside the project (`qunitx /tmp/a-test.ts`).
 *
 * ```ts
 * import * as NoBundle from './no-bundle.ts';
 * import { HTTPServer } from '../web/index.ts';
 *
 * const server = new HTTPServer();
 * const state = NoBundle.createState('/proj', { importMap: { imports: {}, scopes: {} }, roots: ['/proj'] });
 * NoBundle.registerRoutes(server, state, () => []);
 * await server.close();
 * ```
 */
export function registerRoutes(
  server: HTTPServer,
  state: NoBundleState,
  extraRoots: () => string[],
): void {
  server.get(ImportMap.EMBEDDED_QUNITX_URL, async (_req, res) => {
    res.writeHead(200, { 'Content-Type': JAVASCRIPT_CONTENT_TYPE, 'Cache-Control': 'no-store' });
    res.end(await readTemplate('vendor/qunitx-runtime.js'));
  });
  server.get(LOAD_ERRORS_URL, (req, res) => {
    const testFile = ImportMap.fromFsUrl(new URL(String(req.query.for ?? ''), 'http://x').pathname);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(testFile ? loadErrorsFor(state, testFile) : []));
  });
  server.get(`${ImportMap.FS_PREFIX}/*`, (req, res) => serveModule(state, extraRoots, req, res));
}

/**
 * The load errors that explain why `testFile` failed to load: those of modules reachable from it
 * through the import graph the browser walked. Another file's broken import is not this file's.
 *
 * ```ts
 * import * as NoBundle from './no-bundle.ts';
 *
 * const state = NoBundle.createState('/proj', { importMap: { imports: {}, scopes: {} }, roots: ['/proj'] });
 * state.edges.set('/proj/test/a-test.ts', new Set(['/proj/lib/a.ts']));
 * state.loadErrors.set('x', { file: '/proj/lib/b', importer: '/proj/lib/a.ts', reason: 'cannot find lib/b' });
 * state.loadErrors.set('y', { file: '/proj/lib/c', importer: '/proj/test/c-test.ts', reason: 'cannot find lib/c' });
 *
 * NoBundle.loadErrorsFor(state, '/proj/test/a-test.ts'); // ['cannot find lib/b']
 * ```
 */
export function loadErrorsFor(state: NoBundleState, testFile: string): string[] {
  const reachable = new Set([testFile]);
  for (const file of reachable) {
    for (const imported of state.edges.get(file) ?? []) reachable.add(imported);
  }

  return [...state.loadErrors.values()]
    .filter((error) => reachable.has(error.file) || reachable.has(error.importer ?? ''))
    .map((error) => error.reason);
}

/**
 * Forgets the previous build's load errors. Called whenever a new entry is built, so a failure the
 * user has since fixed is never reported again.
 *
 * ```ts
 * import * as NoBundle from './no-bundle.ts';
 *
 * const state = NoBundle.createState('/proj', { importMap: { imports: {}, scopes: {} }, roots: ['/proj'] });
 * state.loadErrors.set('stale', { file: '/proj/a', importer: null, reason: 'stale' });
 * NoBundle.resetRun(state);
 * state.loadErrors.size; // 0
 * ```
 */
export function resetRun(state: NoBundleState): void {
  state.loadErrors.clear();
}

// ── serving ──────────────────────────────────────────────────────────────────

async function serveModule(
  state: NoBundleState,
  extraRoots: () => string[],
  req: Request,
  res: Response,
): Promise<void> {
  const requested = ImportMap.fromFsUrl(req.path);
  const importer = importerOf(req);
  const display = (file: string) => displayPath(state.projectRoot, file);
  const fail = (status: number, file: string, reason: string) => {
    const message = importer ? `${reason} (imported by ${display(importer)})` : reason;
    state.loadErrors.set(message, { file, importer, reason: message });
    res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end(message);
  };
  if (!requested) return fail(400, req.path, `${req.path} is not a file URL`);
  if (importer) recordEdge(state, importer, requested);

  const file = await locate(requested);
  if (!file) {
    return fail(404, requested, `cannot find ${display(requested)}${await suggestion(requested)}`);
  }
  if (!(await isServable(file, state.roots.concat(extraRoots())))) {
    return fail(
      403,
      file,
      `${display(file)} is outside the directories a --no-bundle run serves (the project, its ` +
        'dependencies, the test files and import-map targets)',
    );
  }
  if (importer && file !== requested) recordEdge(state, importer, file);

  const result = await transformCached(state, file).catch((error: Error) => error);
  if (result instanceof Error) {
    return fail(500, file, `could not compile ${display(file)}: ${result.message}`);
  }
  state.modules.set(req.path, result.served);
  res.writeHead(200, { 'Content-Type': result.contentType, 'Cache-Control': 'no-store' });
  res.end(result.served.code);
}

async function transformCached(
  state: NoBundleState,
  file: string,
): Promise<{ served: ServedModule; contentType: string }> {
  const stats = await fs.stat(file);
  const stamp = `${stats.mtimeMs}:${stats.size}`;
  const cached = state.transforms.get(file);
  if (cached?.stamp === stamp) return cached;

  const source = await fs.readFile(file, 'utf8');
  const extension = path.extname(file);
  const isScript = isTransformed(extension) || isJavaScript(extension);
  const { code, map } = isScript ? await transform(file, source) : { code: source, map: null };
  const entry = {
    stamp,
    served: { absolutePath: file, code, source, map },
    contentType: isScript ? JAVASCRIPT_CONTENT_TYPE : contentTypeOf(extension),
  };
  state.transforms.set(file, entry);

  return entry;
}

/** The file to serve for a request: the path itself, or the TypeScript source a `.js` import means. */
async function locate(requested: string): Promise<string | null> {
  if (await isFile(requested)) return requested;
  const extension = path.extname(requested);
  for (const sourceExtension of SOURCE_FOR_OUTPUT[extension] ?? []) {
    const candidate = requested.slice(0, -extension.length) + sourceExtension;
    if (await isFile(candidate)) return candidate;
  }

  return null;
}

/** ` — did you mean ./util.ts?` for an extensionless import a bundler would have guessed at. */
async function suggestion(requested: string): Promise<string> {
  if (path.extname(requested)) return '';
  for (const guess of EXTENSION_GUESSES) {
    if (await isFile(requested + guess)) {
      return ` — imports need their file extension in a --no-bundle run; did you mean ${path.basename(requested)}${guess}?`;
    }
  }

  return '';
}

function importerOf(req: Request): string | null {
  const referer = req.headers.referer;
  if (!referer) return null;
  try {
    return ImportMap.fromFsUrl(new URL(referer).pathname);
  } catch {
    return null;
  }
}

function recordEdge(state: NoBundleState, importer: string, imported: string): void {
  const imports = state.edges.get(importer) ?? new Set<string>();
  imports.add(imported);
  state.edges.set(importer, imports);
}

/**
 * Inside one of `roots`, by the path as requested or by its real path — a project reached through
 * a symlinked directory has roots in both spellings, and a package's URL is its real path.
 */
async function isServable(file: string, roots: string[]): Promise<boolean> {
  const within = (candidate: string) =>
    roots.some(
      (root) =>
        candidate === root ||
        candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep),
    );
  if (within(file)) return true;
  const real = await fs.realpath(file).catch(() => null);

  return real !== null && within(real);
}

function displayPath(projectRoot: string, file: string): string {
  const relative = path.relative(projectRoot, file);

  return relative.startsWith('..') || path.isAbsolute(relative)
    ? file
    : relative.replaceAll('\\', '/');
}

function isJavaScript(extension: string): boolean {
  return extension === '.js' || extension === '.mjs' || extension === '.cjs';
}

function contentTypeOf(extension: string): string {
  if (extension === '.json') return 'application/json';
  if (extension === '.wasm') return 'application/wasm';

  return MIME_TYPES[extension.slice(1).toLowerCase()] ?? 'application/octet-stream';
}

function isFile(file: string): Promise<boolean> {
  return fs.stat(file).then(
    (stats) => stats.isFile(),
    () => false,
  );
}
