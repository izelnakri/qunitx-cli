import fs from 'node:fs/promises';
import path from 'node:path';
import { Failure } from '../../result/index.ts';

// Bumping the declared range in whichever manifest the project actually uses. Never installs
// anything: the range is a decision recorded in a file, and fetching it is the user's call.

// `npm:qunitx-cli@^0.34.5` / `jsr:@izelnakri/qunitx-cli@~0.34.5`, as `deno add` writes them. The
// version is edited in place rather than through JSON.parse + JSON.stringify, which would strip a
// deno.jsonc's comments and reformat everything else on the way past.
const DENO_IMPORT = /(npm:qunitx-cli@|jsr:@izelnakri\/qunitx-cli@)([~^]?)(\d+\.\d+\.\d+[^"']*)/;

/**
 * A manifest that declares qunitx-cli, but not at a version this can bump — an unpinned
 * specifier, or a dependency that is not declared there at all.
 *
 * ```ts
 * import * as Manifest from './manifest.ts';
 *
 * Manifest.EntryMissing({ manifest: '/proj/deno.json' }).code; // 'UpgradeManifestEntryMissing'
 * ```
 */
export const EntryMissing: Failure.FailureFactory<
  'UpgradeManifestEntryMissing',
  { manifest: string }
> = Failure.define(
  'UpgradeManifestEntryMissing',
  (data: { manifest: string }) =>
    `No pinned qunitx-cli version found in ${data.manifest} — nothing to bump.`,
);

/**
 * Points the manifest's qunitx-cli entry at `version`, keeping whatever range operator it already
 * used: `^` stays `^`, `~` stays `~`, and an exact pin stays exact.
 *
 * ```ts
 * import * as Manifest from './manifest.ts';
 *
 * // Defined, not invoked: rewrites a file on disk.
 * async function bumpProject() {
 *   return await Manifest.bump('/proj/deno.json', '0.35.0'); // { field: 'imports', range: '^0.35.0' }
 * }
 * ```
 *
 * @returns which part of the manifest changed, and the range now written there.
 */
export async function bump(manifestPath: string, version: string): Promise<BumpedEntry> {
  const text = await fs.readFile(manifestPath, 'utf8');
  if (path.basename(manifestPath) === 'package.json') {
    return await bumpPackageJSON(manifestPath, text, version);
  }

  const entry = DENO_IMPORT.exec(text);
  if (!entry) throw EntryMissing({ manifest: manifestPath });

  // One substring, replaced at the offset it was found: everything else in the file — comments,
  // key order, indentation, trailing commas a .jsonc is allowed to carry — comes through untouched.
  const start = entry.index + entry[1].length;
  await fs.writeFile(
    manifestPath,
    `${text.slice(0, start)}${entry[2]}${version}${text.slice(start + entry[2].length + entry[3].length)}`,
  );

  return { field: 'imports', range: `${entry[2]}${version}` };
}

/**
 * What {@link bump} changed: where the entry lives, and the range it now carries.
 *
 * ```ts
 * import type { BumpedEntry } from './manifest.ts';
 *
 * const bumped: BumpedEntry = { field: 'devDependencies', range: '~0.35.0' };
 * bumped.range; // '~0.35.0' — the operator the project chose, kept
 * ```
 */
export interface BumpedEntry {
  /** The part of the manifest that changed: `imports`, `dependencies` or `devDependencies`. */
  field: string;
  /** The range now written there, operator included. */
  range: string;
}

/**
 * Which registry a deno manifest pins qunitx-cli through, so a refusal names the `deno add` that
 * updates the entry already there instead of adding a second one beside it. `npm` when the file
 * says nothing, matching what `deno add qunitx-cli` resolves to.
 *
 * ```ts
 * import * as Manifest from './manifest.ts';
 *
 * // Defined, not invoked: reads a file from disk.
 * async function pinnedThrough() {
 *   return await Manifest.registry('/proj/deno.json'); // 'jsr' when the import says jsr:
 * }
 * ```
 */
export async function registry(manifestPath: string): Promise<'npm' | 'jsr'> {
  const text = await fs.readFile(manifestPath, 'utf8').catch(() => '');

  return text.includes('jsr:@izelnakri/qunitx-cli') ? 'jsr' : 'npm';
}

async function bumpPackageJSON(
  manifestPath: string,
  text: string,
  version: string,
): Promise<BumpedEntry> {
  const manifest = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  const field = manifest.dependencies?.['qunitx-cli'] ? 'dependencies' : 'devDependencies';
  const previous = manifest[field]?.['qunitx-cli'];
  if (previous === undefined) throw EntryMissing({ manifest: manifestPath });

  const range = `${previous.startsWith('^') || previous.startsWith('~') ? previous[0] : ''}${version}`;
  manifest[field] = { ...manifest[field], 'qunitx-cli': range };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { field, range };
}
