import fs from 'node:fs';
import path from 'node:path';
import { paint } from './columns.ts';
import { highlight } from './highlight.ts';
import type { Theme } from './theme.ts';

/** The commands that take a path, and so complete like a shell rather than like an expression. */
const PATH_COMMANDS = /^\s*\.(?:cat|view|tree)\s+(?:.*\s)?(\S*)$/;
/** `-L 2`, anywhere in the argument, the way `tree` takes it. */
const DEPTH_FLAG = /(?:^|\s)-L\s*(\d+)(?:\s|$)/;

// Highlighted only where the highlighter knows the language. A `.md` file run through a JavaScript
// tokenizer comes out with prose coloured as keywords, which is worse than not colouring it.
const HIGHLIGHTED = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.json',
]);

/**
 * The path being typed on a `.cat` or `.view` line, or `null` on any other line.
 *
 * What decides whether a completion is a filename or an expression. A path with a space in it is
 * not completable here, which is the same bargain a dot command already makes with its argument.
 *
 * ```ts
 * import { fragment } from './files.ts';
 *
 * fragment('.cat lib/re'); // 'lib/re'
 * fragment('.view '); // '' — everything in the working directory
 * fragment('document.ti'); // null — an expression, not a path
 * ```
 */
export function fragment(line: string): string | null {
  const typed = PATH_COMMANDS.exec(line)?.[1];
  if (typed === undefined) return null;
  // `-L` takes a number, and a number is not a path. Completing one would offer files for it.
  if (typed.startsWith('-') || /(?:^|\s)-L\s*$/.test(line.slice(0, line.length - typed.length))) {
    return null;
  }

  return typed;
}

/**
 * What a path command was pointed at, and how deep it was asked to go.
 *
 * ```ts
 * import { target } from './files.ts';
 *
 * target('-L 2 lib'); // { depth: 2, path: 'lib' }
 * target('lib'); // { depth: Infinity, path: 'lib' } — all the way down unless told otherwise
 * target(''); // { depth: Infinity, path: '.' } — here
 * ```
 */
export function target(argument: string): { depth: number; path: string } {
  const depth = DEPTH_FLAG.exec(argument);
  const rest = argument.replace(DEPTH_FLAG, ' ').trim();

  return { depth: depth ? Number(depth[1]) : Infinity, path: rest === '' ? '.' : rest };
}

/**
 * The paths that continue `typed`, spelled the way it was — directories with a trailing slash.
 *
 * Hidden entries only once a dot has been typed, which is the rule every shell uses and the reason
 * `.cat ` does not open with a list of dotfiles.
 *
 * ```ts
 * import { complete } from './files.ts';
 *
 * complete('lib/re', process.cwd()); // ['lib/repl/'] — a directory, and it says so
 * complete('nowhere/at/all', process.cwd()); // [] — an unreadable directory completes to nothing
 * ```
 */
export function complete(typed: string, cwd: string): string[] {
  const slash = typed.lastIndexOf('/');
  // Kept verbatim rather than rebuilt, so `./lib/` and `lib/` each come back the way they went in.
  const prefix = typed.slice(0, slash + 1);
  const partial = typed.slice(slash + 1);
  const directory = path.resolve(cwd, prefix || '.');

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.name.startsWith(partial))
    .filter((entry) => partial.startsWith('.') || !entry.name.startsWith('.'))
    .map((entry) => `${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`)
    .sort();
}

/**
 * What to draw after the cursor on a path line: the rest of the shortest path that continues it.
 *
 * Empty for a line that is not one, so a caller can fall through to the suggestions it makes for
 * everything else. Shortest for the same reason a name is: `lib/` is what `li` meant far more
 * often than the longest thing underneath it.
 *
 * ```ts
 * import { suggest } from './files.ts';
 *
 * suggest('document.ti', process.cwd()); // '' — not a path line, so not this one's answer
 * ```
 */
export function suggest(line: string, cwd: string): string {
  const typed = fragment(line);
  if (typed === null || typed === '') return '';

  let best = '';
  for (const candidate of complete(typed, cwd)) {
    if (candidate.length <= typed.length) continue;
    if (best === '' || candidate.length < best.length) best = candidate;
  }

  return best === '' ? '' : best.slice(typed.length);
}

/**
 * A file with its lines numbered, the way anybody quoting one writes them down.
 *
 * ```
 * 1 | let something = 'something';
 * 2 | function me() {
 * ```
 *
 * Numbers are right-aligned to the longest of them, so the gutter is a straight edge and the code
 * starts in one column rather than drifting at line 100.
 *
 * ```ts
 * import { numbered } from './files.ts';
 *
 * numbered('a\nb', 'x.txt', { style: () => '' }); // '1 | a\n2 | b' — the gutter is themed too
 * ```
 */
export function numbered(contents: string, file: string, palette: Theme): string {
  const lines = contents.replace(/\n$/, '').split('\n');
  const gutter = String(lines.length).length;
  const isCode = HIGHLIGHTED.has(path.extname(file).toLowerCase());
  const style = palette.style('LineNr');

  return lines
    .map((line, index) => {
      const number = `${String(index + 1).padStart(gutter)} |`;
      const content = isCode ? highlight(line, palette) : line;

      return `${paint(number, style)} ${content}`;
    })
    .join('\n');
}

/** What a path turned out to be, and what the prompt should do about it. */
export type Resolution =
  | { kind: 'file'; contents: string }
  | { kind: 'directory'; retype: string }
  | { kind: 'missing'; retype: string }
  | { kind: 'unreadable'; detail: string };

/**
 * Reads a path, or says precisely why it could not — and how much of it was worth keeping.
 *
 * `retype` is the part that does exist, which is what the prompt puts back so the next attempt
 * costs a few keystrokes rather than the whole path again. For a directory that is the path with
 * a slash on it; for a path that goes wrong halfway, it is the last directory that was real.
 *
 * ```ts
 * import { read } from './files.ts';
 *
 * read('lib/nowhere.ts', process.cwd()); // { kind: 'missing', retype: 'lib/' }
 * read('lib', process.cwd()); // { kind: 'directory', retype: 'lib/' }
 * ```
 */
export function read(typed: string, cwd: string): Resolution {
  const resolved = path.resolve(cwd, typed);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code !== 'ENOENT') return { kind: 'unreadable', detail: failure.message };

    return { kind: 'missing', retype: existingPrefix(typed, cwd) };
  }
  if (stats.isDirectory()) return { kind: 'directory', retype: withSlash(typed) };

  try {
    return { kind: 'file', contents: fs.readFileSync(resolved, 'utf8') };
  } catch (error) {
    return { kind: 'unreadable', detail: (error as Error).message };
  }
}

function withSlash(typed: string): string {
  return typed.endsWith('/') ? typed : `${typed}/`;
}

/** The longest leading run of `typed` that is a real directory, ending in a slash. */
function existingPrefix(typed: string, cwd: string): string {
  const parts = typed.split('/');
  let kept = '';
  for (const part of parts.slice(0, -1)) {
    const next = `${kept}${part}/`;
    try {
      if (!fs.statSync(path.resolve(cwd, next)).isDirectory()) break;
    } catch {
      break;
    }
    kept = next;
  }

  return kept;
}

/** How a tree came out, and whether it was all of it. */
export interface Tree {
  /** The listing, root line included. */
  listing: string;
  /** Directories and files reached. */
  counted: { directories: number; files: number };
  /** Entries left undrawn where the cap stopped it, or 0 where nothing was. */
  omitted: number;
}

// Deep enough to be worth calling unlimited, bounded enough that `.tree` in a project root cannot
// take the terminal with it. Whatever it leaves out, it SAYS it left out — a listing that quietly
// stops is a listing that lies about what is there.
const TREE_LIMIT = 5_000;

/**
 * A directory drawn the way `tree` draws one.
 *
 * ```
 * lib/
 * ├── api/
 * │   └── index.ts
 * └── repl/
 *     └── files.ts
 * ```
 *
 * All the way down unless `depth` says otherwise, where 1 is the directory's own contents. Hidden
 * entries are left out, as `tree` leaves them out, which is also what keeps `.git` from being most
 * of the answer. Symlinks are named but not followed — a link into a parent is a tree with no end.
 *
 * ```ts
 * import { tree } from './files.ts';
 *
 * tree('lib', process.cwd(), { style: () => '' }, 1).listing.startsWith('lib/'); // true
 * ```
 */
export function tree(root: string, cwd: string, palette: Theme, depth: number = Infinity): Tree {
  const directoryStyle = palette.style('Directory');
  const branchStyle = palette.style('LineNr');
  const counted = { directories: 0, files: 0 };
  const lines = [paint(`${withSlash(root)}`, directoryStyle)];
  let omitted = 0;

  const walk = (directory: string, prefix: string, level: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      // A directory that cannot be read is a leaf, not a failure — one unreadable subdirectory is
      // no reason to refuse the rest of the tree.
      return;
    }
    const visible = entries
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((left, right) => (left.name < right.name ? -1 : 1));

    for (const [index, entry] of visible.entries()) {
      if (lines.length > TREE_LIMIT) {
        omitted += visible.length - index;

        return;
      }
      const last = index === visible.length - 1;
      const isDirectory = entry.isDirectory();
      counted[isDirectory ? 'directories' : 'files'] += 1;
      const name = paint(
        `${entry.name}${isDirectory ? '/' : ''}`,
        isDirectory ? directoryStyle : '',
      );
      lines.push(`${paint(`${prefix}${last ? '└── ' : '├── '}`, branchStyle)}${name}`);
      if (isDirectory && level < depth) {
        walk(path.join(directory, entry.name), `${prefix}${last ? '    ' : '│   '}`, level + 1);
      }
    }
  };

  walk(path.resolve(cwd, root), '', 1);

  return { listing: lines.join('\n'), counted, omitted };
}
