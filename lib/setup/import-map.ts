import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as Failure from '../result/failure.ts';

/**
 * A browser import map: what a `--no-bundle` run hands the page in place of a bundler's resolver.
 *
 * ```ts
 * import type { ImportMap } from './import-map.ts';
 *
 * const map: ImportMap = { imports: { qunitx: '/@qunitx/runtime.js' }, scopes: {} };
 * map.imports.qunitx; // '/@qunitx/runtime.js'
 * ```
 */
export interface ImportMap {
  /** Specifier (or `prefix/`) → URL, for every module on the page. */
  imports: Record<string, string>;
  /** URL prefix of an importer → entries that override `imports` for modules under it. */
  scopes: Record<string, Record<string, string>>;
}

/**
 * The import map of a run, and every directory the run's server may serve modules from.
 *
 * ```ts
 * import type { ResolvedImportMap } from './import-map.ts';
 *
 * const resolved: ResolvedImportMap = { importMap: { imports: {}, scopes: {} }, roots: ['/proj'] };
 * resolved.roots; // ['/proj'] — a module outside every root is not served
 * ```
 */
export interface ResolvedImportMap {
  /** The map every page of the run carries. */
  importMap: ImportMap;
  /** Absolute directories (real paths) the server may serve files from. */
  roots: string[];
}

/**
 * `package.json#qunitx.importMap` named a file that could not be read or is not an import map.
 *
 * ```ts
 * import { ImportMapUnreadable } from './import-map.ts';
 *
 * const failure = ImportMapUnreadable({ file: 'import-map.json', reason: 'no such file' });
 * failure.message; // 'could not read the import map import-map.json: no such file'
 * ```
 */
export const ImportMapUnreadable: Failure.FailureFactory<
  'ImportMapUnreadable',
  { file: string; reason: string }
> = Failure.define(
  'ImportMapUnreadable',
  (data: { file: string; reason: string }) =>
    `could not read the import map ${data.file}: ${data.reason}`,
);

/**
 * URL prefix that addresses a file by its absolute path on the server's filesystem.
 *
 * ```ts
 * import { FS_PREFIX, toFsUrl } from './import-map.ts';
 *
 * toFsUrl('/proj/a.ts').startsWith(FS_PREFIX); // true
 * ```
 */
export const FS_PREFIX = '/@fs';

/**
 * URL of the runtime qunitx embeds, served when the project has not installed qunitx itself.
 *
 * ```ts
 * import { EMBEDDED_QUNITX_URL } from './import-map.ts';
 *
 * EMBEDDED_QUNITX_URL; // '/@qunitx/runtime.js' — what `qunitx` maps to with no local install
 * ```
 */
export const EMBEDDED_QUNITX_URL = '/@qunitx/runtime.js';

/**
 * Export conditions a browser module graph matches, in priority order. `node`, `require` and
 * `deno` are deliberately absent: the page is a browser, and the entry those conditions name is
 * the one that would `import 'node:fs'`.
 */
const CONDITIONS = new Set(['browser', 'import', 'module', 'default']);

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;

// esm.sh serves npm and JSR packages as browser ESM, which is how a deno.json `npm:`/`jsr:` entry
// with no local install still resolves.
const NPM_CDN = 'https://esm.sh/';
const JSR_CDN = 'https://esm.sh/jsr/';

interface PackageJSON {
  name?: string;
  main?: string;
  module?: string;
  browser?: unknown;
  exports?: unknown;
  imports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  qunitx?: { importMap?: unknown };
}

/**
 * The URL a file is served at: its absolute path under {@link FS_PREFIX}. A directory gets the
 * trailing slash import-map prefixes and scopes need.
 *
 * ```ts
 * import { toFsUrl } from './import-map.ts';
 *
 * toFsUrl('/proj/test/a test.ts'); // '/@fs/proj/test/a%20test.ts'
 * toFsUrl('/proj/node_modules/x', true); // '/@fs/proj/node_modules/x/'
 * ```
 */
export function toFsUrl(absolutePath: string, isDirectory = false): string {
  const url = `${FS_PREFIX}${pathToFileURL(absolutePath).pathname}`;

  return isDirectory && !url.endsWith('/') ? `${url}/` : url;
}

/**
 * The absolute path a {@link toFsUrl} URL names, or `null` for any other URL.
 *
 * ```ts
 * import { fromFsUrl } from './import-map.ts';
 *
 * fromFsUrl('/@fs/proj/test/a%20test.ts'); // '/proj/test/a test.ts'
 * fromFsUrl('/tests.js'); // null
 * ```
 */
export function fromFsUrl(pathname: string): string | null {
  if (!pathname.startsWith(`${FS_PREFIX}/`)) return null;
  try {
    return fileURLToPath(`file://${pathname.slice(FS_PREFIX.length)}`);
  } catch {
    return null; // a malformed escape, or a path that is not absolute on this platform
  }
}

/**
 * Resolves a package's `exports` for one subpath, matching browser conditions. Returns the
 * package-relative target (`./dist/x.js`), or `null` when the package does not export it.
 *
 * ```ts
 * import { resolveExports } from './import-map.ts';
 *
 * const exports = { '.': { node: './node.js', default: './browser.js' }, './utils/*': './src/utils/*.js' };
 * resolveExports(exports, '.'); // './browser.js'
 * resolveExports(exports, './utils/date'); // './src/utils/date.js'
 * resolveExports(exports, './private'); // null
 * ```
 */
export function resolveExports(exportsField: unknown, subpath: string): string | null {
  if (!isSubpathMap(exportsField)) return subpath === '.' ? resolveTarget(exportsField, '') : null;
  if (Object.hasOwn(exportsField, subpath) && !subpath.includes('*')) {
    return resolveTarget(exportsField[subpath], '');
  }
  const pattern = Object.keys(exportsField)
    .filter((key) => {
      const [prefix, suffix = ''] = key.split('*');
      return (
        key.includes('*') &&
        subpath.startsWith(prefix) &&
        subpath.endsWith(suffix) &&
        subpath.length >= key.length - 1
      );
    })
    .sort((a, b) => b.indexOf('*') - a.indexOf('*'))[0];
  if (!pattern) return null;
  const [prefix, suffix = ''] = pattern.split('*');

  return resolveTarget(
    exportsField[pattern],
    subpath.slice(prefix.length, subpath.length - suffix.length),
  );
}

/**
 * The import-map entries one installed package contributes: its main entry, every subpath it
 * exports, and — for a package with no `exports` at all — a prefix that opens up its whole
 * directory, the way Node lets you deep-import such a package.
 *
 * An `exports` pattern becomes a prefix entry only when the import map can express it, which is
 * when the pattern's text after `*` matches the target's (`./*` → `./dist/*`, `./*.js` →
 * `./lib/*.js`). Anything else — `./feature-*` → `./x/*.mjs` — is left out rather than guessed at.
 *
 * ```ts
 * import { packageEntries } from './import-map.ts';
 *
 * packageEntries('lit', '/proj/node_modules/lit', { exports: { '.': './index.js', './decorators/*': './decorators/*' } });
 * // { lit: '/@fs/proj/node_modules/lit/index.js',
 * //   'lit/decorators/': '/@fs/proj/node_modules/lit/decorators/' }
 * packageEntries('old', '/proj/node_modules/old', { main: 'lib/index.js' });
 * // { old: '/@fs/proj/node_modules/old/lib/index.js', 'old/': '/@fs/proj/node_modules/old/' }
 * ```
 */
export function packageEntries(
  name: string,
  packageDir: string,
  packageJSON: PackageJSON,
): Record<string, string> {
  const base = toFsUrl(packageDir, true);
  const url = (target: string) => new URL(target, `http://pkg${base}`).pathname;
  const exportsField = packageJSON.exports;

  if (exportsField === undefined || exportsField === null) {
    const browserMain = typeof packageJSON.browser === 'string' ? packageJSON.browser : undefined;
    const main = browserMain ?? packageJSON.module ?? packageJSON.main ?? 'index.js';
    return { [name]: url(withJsExtension(main)), [`${name}/`]: base };
  }
  if (!isSubpathMap(exportsField)) {
    const target = resolveTarget(exportsField, '');
    return target ? { [name]: url(target) } : {};
  }

  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(exportsField)) {
    if (!key.includes('*')) {
      const target = resolveTarget(value, '');
      if (target) entries[key === '.' ? name : `${name}/${key.slice(2)}`] = url(target);
      continue;
    }
    const [keyPrefix, keySuffix] = key.split('*');
    const [targetPrefix, targetSuffix] = (resolveTarget(value, '*') ?? '').split('*');
    if (targetSuffix === keySuffix && keyPrefix.endsWith('/') && targetPrefix.endsWith('/')) {
      entries[`${name}/${keyPrefix.slice(2)}`] = url(targetPrefix);
    }
  }

  return entries;
}

/**
 * Builds a run's import map. Three layers, each overriding the one before it:
 *
 * 1. **node_modules** — every package `package.json` depends on (all four dependency fields),
 *    and everything those depend on in turn, resolved the way Node resolves them. A package
 *    installed in two versions gets a `scopes` entry for the importer that sees the other one.
 *    The project's own `exports` (self-reference) and `imports` (`#internal`) are included, and
 *    `qunitx` falls back to the runtime this CLI embeds when the project has not installed it.
 * 2. **deno.json / deno.jsonc** — its `imports` and `scopes`, or the file its `importMap` names.
 *    `npm:` entries resolve to the local install when there is one; `npm:` and `jsr:` entries
 *    with none resolve to esm.sh.
 * 3. **`package.json#qunitx.importMap`** — an import map object, or the path of a JSON file
 *    holding one.
 *
 * Relative targets resolve against the file that declares them, as in a browser or Deno.
 *
 * ```ts
 * import * as ImportMap from './import-map.ts';
 *
 * // Defined, not invoked: walks the project's node_modules.
 * async function example() {
 *   const { importMap } = await ImportMap.build('/proj');
 *   return importMap.imports.qunitx; // '/@fs/proj/node_modules/qunitx/dist/browser/index.js'
 * }
 * ```
 */
export async function build(projectRoot: string): Promise<ResolvedImportMap> {
  const roots = new Set([await realpathOrSelf(projectRoot)]);
  const rootPackageJSON = (await readJSON(path.join(projectRoot, 'package.json'))) as PackageJSON;
  const installed = await nodeModulesImportMap(projectRoot, rootPackageJSON, roots);
  const deno = await denoImportMap(projectRoot, installed, roots);
  const user = await userImportMap(
    projectRoot,
    rootPackageJSON.qunitx?.importMap,
    installed,
    roots,
  );
  const importMap = [deno, user].reduce(merge, installed);
  importMap.imports.qunitx ??= EMBEDDED_QUNITX_URL;

  return { importMap, roots: [...roots] };
}

/**
 * Overlays `overlay` onto `base`: `imports` entry by entry, `scopes` scope by scope.
 *
 * ```ts
 * import { merge } from './import-map.ts';
 *
 * merge(
 *   { imports: { a: '/a.js', b: '/b.js' }, scopes: { '/x/': { a: '/xa.js' } } },
 *   { imports: { b: '/b2.js' }, scopes: { '/x/': { c: '/xc.js' } } },
 * );
 * // { imports: { a: '/a.js', b: '/b2.js' }, scopes: { '/x/': { a: '/xa.js', c: '/xc.js' } } }
 * ```
 */
export function merge(base: ImportMap, overlay: ImportMap): ImportMap {
  const scopes = { ...base.scopes };
  for (const [scope, entries] of Object.entries(overlay.scopes)) {
    scopes[scope] = { ...scopes[scope], ...entries };
  }

  return { imports: { ...base.imports, ...overlay.imports }, scopes };
}

/**
 * Parses JSON with comments and trailing commas — the dialect `deno.jsonc` is written in.
 *
 * ```ts
 * import { parseJsonc } from './import-map.ts';
 *
 * parseJsonc('{ // the map\n "imports": { "a": "./a.ts", }, /* done *\/ }'); // { imports: { a: './a.ts' } }
 * ```
 */
export function parseJsonc(text: string): unknown {
  // Strings are matched first and kept, so a `//` inside one ("https://…") is never a comment.
  const stripped = text.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_match, string) => string ?? '',
  );

  return JSON.parse(
    stripped.replace(
      /("(?:\\.|[^"\\])*")|,(\s*[}\]])/g,
      (_match, string, close) => string ?? close,
    ),
  );
}

// ── node_modules ─────────────────────────────────────────────────────────────

async function nodeModulesImportMap(
  projectRoot: string,
  rootPackageJSON: PackageJSON,
  roots: Set<string>,
): Promise<ImportMap> {
  const importMap: ImportMap = { imports: {}, scopes: {} };
  const hoistedDir = path.join(projectRoot, 'node_modules');
  const visitedPackages = new Set<string>();

  // Breadth-first, one level per round, each level's lookups in parallel. A dependency resolved
  // to the hoisted copy (`<root>/node_modules/<name>`) goes in `imports`, where every module
  // finds it; one resolved to a nested copy is visible only to its importer, through `scopes`.
  let level = dependencyNames(rootPackageJSON, true).map((name) => ({
    name,
    importerDir: projectRoot,
  }));
  while (level.length > 0) {
    const resolved = await Promise.all(
      level.map(async ({ name, importerDir }) => {
        const packageDir = await findPackageDir(name, importerDir);
        return packageDir && { name, importerDir, packageDir };
      }),
    );
    const next: typeof level = [];
    for (const hit of resolved) {
      if (!hit) continue; // not installed: an optional or peer dependency nobody provided
      const packageJSON = (await readJSON(path.join(hit.packageDir, 'package.json')).catch(
        () => ({}),
      )) as PackageJSON;
      const entries = packageEntries(hit.name, hit.packageDir, packageJSON);
      const isHoisted =
        hit.importerDir === projectRoot ||
        hit.packageDir === (await realpathOrSelf(path.join(hoistedDir, hit.name)));
      if (isHoisted) {
        for (const [key, value] of Object.entries(entries)) importMap.imports[key] ??= value;
      } else {
        const scope = toFsUrl(hit.importerDir, true);
        importMap.scopes[scope] = { ...entries, ...importMap.scopes[scope] };
      }
      if (visitedPackages.has(hit.packageDir)) continue;
      visitedPackages.add(hit.packageDir);
      roots.add(hit.packageDir);
      for (const name of dependencyNames(packageJSON, false)) {
        next.push({ name, importerDir: hit.packageDir });
      }
    }
    level = next;
  }

  // The project's own package: `import 'my-lib'` from its own tests (self-reference, which Node
  // allows only through `exports`), and its `#internal` subpath imports.
  const ownName = rootPackageJSON.name;
  if (ownName && rootPackageJSON.exports !== undefined) {
    for (const [key, value] of Object.entries(
      packageEntries(ownName, projectRoot, rootPackageJSON),
    )) {
      importMap.imports[key] ??= value;
    }
  }
  for (const [key, value] of Object.entries(rootPackageJSON.imports ?? {})) {
    const target = key.includes('*') ? null : resolveTarget(value, '');
    if (target?.startsWith('./'))
      importMap.imports[key] ??= toFsUrl(path.join(projectRoot, target));
  }

  return importMap;
}

function dependencyNames(packageJSON: PackageJSON, includeDev: boolean): string[] {
  const fields = includeDev
    ? [...DEPENDENCY_FIELDS, 'devDependencies' as const]
    : DEPENDENCY_FIELDS;

  return [...new Set(fields.flatMap((field) => Object.keys(packageJSON[field] ?? {})))];
}

/** Node's lookup: `node_modules/<name>` in `fromDir` and every directory above it. Real path. */
async function findPackageDir(name: string, fromDir: string): Promise<string | null> {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    const found = await fs.realpath(candidate).catch(() => null);
    if (found) return found;
    if (path.dirname(dir) === dir) return null;
  }
}

// ── deno.json and the user's own map ─────────────────────────────────────────

async function denoImportMap(
  projectRoot: string,
  installed: ImportMap,
  roots: Set<string>,
): Promise<ImportMap> {
  for (const file of ['deno.json', 'deno.jsonc']) {
    const configPath = path.join(projectRoot, file);
    const text = await fs.readFile(configPath, 'utf8').catch(() => null);
    if (text === null) continue;
    const config = parseJsonc(text) as Partial<ImportMap> & { importMap?: string };
    if (typeof config.importMap === 'string') {
      return readImportMapFile(path.resolve(projectRoot, config.importMap), installed, roots);
    }
    return normalize(config, path.dirname(configPath), installed, roots);
  }

  return { imports: {}, scopes: {} };
}

function userImportMap(
  projectRoot: string,
  declared: unknown,
  installed: ImportMap,
  roots: Set<string>,
): Promise<ImportMap> | ImportMap {
  if (declared === undefined) return { imports: {}, scopes: {} };
  if (typeof declared === 'string') {
    return readImportMapFile(path.resolve(projectRoot, declared), installed, roots);
  }
  if (!isImportMapShape(declared)) {
    throw ImportMapUnreadable({
      file: 'package.json#qunitx.importMap',
      reason: 'expected a path to a JSON file, or an object with `imports` and/or `scopes`',
    });
  }

  return normalize(declared, projectRoot, installed, roots);
}

async function readImportMapFile(
  file: string,
  installed: ImportMap,
  roots: Set<string>,
): Promise<ImportMap> {
  const parsed = await fs
    .readFile(file, 'utf8')
    .then(parseJsonc)
    .catch((error: Error) => {
      throw ImportMapUnreadable({ file, reason: error.message }, { cause: error });
    });
  if (!isImportMapShape(parsed)) {
    throw ImportMapUnreadable({
      file,
      reason: 'expected an object with `imports` and/or `scopes`',
    });
  }

  return normalize(parsed, path.dirname(file), installed, roots);
}

/** Rewrites every target of a declared map into a URL the qunitx server can answer. */
function normalize(
  declared: Partial<ImportMap>,
  baseDir: string,
  installed: ImportMap,
  roots: Set<string>,
): ImportMap {
  const base = pathToFileURL(`${baseDir}${path.sep}`).href;
  const rewrite = (entries: Record<string, string> | undefined) =>
    Object.fromEntries(
      Object.entries(entries ?? {}).map(([key, value]) => [
        key,
        toBrowserUrl(value, base, installed, roots),
      ]),
    );
  const scopes = Object.fromEntries(
    Object.entries(declared.scopes ?? {}).map(([scope, entries]) => [
      toBrowserUrl(scope, base, installed, roots),
      rewrite(entries),
    ]),
  );

  return { imports: rewrite(declared.imports), scopes };
}

/**
 * One declared target, as the page should see it. `npm:` prefers the local install (the same URL
 * the node_modules layer gave that package), then esm.sh; `jsr:` is esm.sh; a relative or `file:`
 * target becomes a {@link toFsUrl} URL; remote URLs pass through.
 */
function toBrowserUrl(
  value: string,
  base: string,
  installed: ImportMap,
  roots: Set<string>,
): string {
  if (value.startsWith('jsr:')) return JSR_CDN + value.slice(4).replace(/^\//, '');
  if (value.startsWith('npm:')) {
    const specifier = value.slice(4).replace(/^\//, '');
    return localNpmUrl(specifier, installed) ?? NPM_CDN + specifier;
  }
  if (!/^(\.{0,2}\/|file:)/.test(value)) return value; // https:, data:, or a bare specifier
  const resolved = new URL(value, base);
  const absolute = fileURLToPath(resolved);
  roots.add(value.endsWith('/') ? absolute : path.dirname(absolute));

  return toFsUrl(absolute, value.endsWith('/'));
}

/** `preact@^10.19/hooks` → the node_modules layer's entry for `preact/hooks`, when installed. */
function localNpmUrl(specifier: string, installed: ImportMap): string | null {
  const match = /^((?:@[^/]+\/)?[^@/]+)(?:@[^/]*)?(\/.*)?$/.exec(specifier);
  if (!match) return null;
  const [, name, subpath = ''] = match;

  return installed.imports[`${name}${subpath}`] ?? null;
}

// ── exports resolution ───────────────────────────────────────────────────────

/** A target with `*` replaced by `star`, following conditions and fallback arrays. */
function resolveTarget(target: unknown, star: string): string | null {
  if (typeof target === 'string') return target.replaceAll('*', star);
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const resolved = resolveTarget(candidate, star);
      if (resolved !== null) return resolved;
    }
    return null;
  }
  if (target && typeof target === 'object') {
    // Key order is the package author's priority order: the first matching condition wins, and a
    // matching condition whose own target fails to resolve falls through to the next.
    for (const [condition, value] of Object.entries(target)) {
      if (!CONDITIONS.has(condition)) continue;
      const resolved = resolveTarget(value, star);
      if (resolved !== null) return resolved;
    }
  }

  return null;
}

/** True for `{ ".": …, "./x": … }`, as opposed to a conditions object or a bare target. */
function isSubpathMap(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).some((key) => key.startsWith('.'))
  );
}

function isImportMapShape(value: unknown): value is Partial<ImportMap> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { imports, scopes } = value as Record<string, unknown>;

  return [imports, scopes].every(
    (field) => field === undefined || (typeof field === 'object' && !Array.isArray(field)),
  );
}

/** A `main` written without its extension (`lib/index`) — common before ESM — gets `.js`. */
function withJsExtension(main: string): string {
  const relative = main.startsWith('.') ? main : `./${main}`;
  if (relative.endsWith('/')) return `${relative}index.js`;

  return path.posix.extname(relative) ? relative : `${relative}.js`;
}

function readJSON(file: string): Promise<unknown> {
  return fs.readFile(file, 'utf8').then(JSON.parse);
}

function realpathOrSelf(file: string): Promise<string> {
  return fs.realpath(file).catch(() => file);
}
