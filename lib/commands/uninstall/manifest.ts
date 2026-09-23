import fs from 'node:fs/promises';
import { Failure } from '../../result/index.ts';

// Taking qunitx out of a project's manifest — the half of `--write-manifest` that is a file edit.
// Nothing is installed or deleted from node_modules: the entry is a decision recorded in a file,
// and making the install match it is the project's own package manager's job.

/**
 * The manifest does not declare qunitx-cli, so there is no entry to take out.
 *
 * ```ts
 * import { NotDeclared } from './manifest.ts';
 *
 * NotDeclared({ manifest: '/proj/package.json' }).message;
 * // 'No qunitx-cli entry in /proj/package.json — nothing to remove.'
 * ```
 */
export const NotDeclared: Failure.FailureFactory<'UninstallNotDeclared', { manifest: string }> =
  Failure.define(
    'UninstallNotDeclared',
    (data: { manifest: string }) => `No qunitx-cli entry in ${data.manifest} — nothing to remove.`,
  );

/** The one failure this module declares. */
export type NotDeclaredFailure = Failure.Of<typeof NotDeclared>;

/**
 * Removes the qunitx-cli entry from a `package.json` or a `deno.json(c)`.
 *
 * A package.json is parsed, because its dependency blocks are plain JSON and re-serialising them
 * is safe. A deno.jsonc is not: it may carry comments and trailing commas that `JSON.parse` would
 * throw away, so its import line is cut out textually and the rest of the file is left untouched.
 *
 * ```ts
 * import * as Manifest from './manifest.ts';
 *
 * // Defined, not invoked: rewrites a file on disk.
 * async function drop() {
 *   return await Manifest.remove('/proj/package.json'); // 'devDependencies'
 * }
 * ```
 *
 * @returns which block the entry was in, for the sentence the command prints.
 */
export async function remove(manifestPath: string): Promise<string> {
  const source = await fs.readFile(manifestPath, 'utf8');

  if (manifestPath.endsWith('.json') && !manifestPath.endsWith('deno.json')) {
    return await removeFromPackageJson(manifestPath, source);
  }

  return await removeFromDenoManifest(manifestPath, source);
}

/** The blocks a dependency can be declared in, in the order npm resolves them. */
const BLOCKS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

async function removeFromPackageJson(manifestPath: string, source: string): Promise<string> {
  const parsed = JSON.parse(source) as Record<string, Record<string, string> | undefined>;
  const block = BLOCKS.find((name) => parsed[name]?.['qunitx-cli'] !== undefined);
  if (block === undefined) throw NotDeclared({ manifest: manifestPath });

  delete parsed[block]?.['qunitx-cli'];
  // An emptied block is removed with it: `"devDependencies": {}` is a leftover, not a decision.
  if (Object.keys(parsed[block] ?? {}).length === 0) delete parsed[block];
  // The trailing newline every package.json has, and npm rewrites, kept.
  await fs.writeFile(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`);

  return block;
}

/** `"qunitx-cli": "npm:qunitx-cli@^0.37.0"` in `imports`, as `deno add` writes it. */
const DENO_ENTRY = /^\s*"[^"]*qunitx-cli"\s*:\s*"(?:npm|jsr):[^"]*"\s*,?\s*\r?\n/m;

async function removeFromDenoManifest(manifestPath: string, source: string): Promise<string> {
  if (!DENO_ENTRY.test(source)) throw NotDeclared({ manifest: manifestPath });
  const without = source.replace(DENO_ENTRY, '');
  // The line before may now be the last in its block and carry a comma that no longer separates
  // anything, which is invalid JSON — and a deno.json this command broke is worse than one it
  // declined to touch.
  await fs.writeFile(manifestPath, without.replace(/,(\s*[}\]])/g, '$1'));

  return 'imports';
}
