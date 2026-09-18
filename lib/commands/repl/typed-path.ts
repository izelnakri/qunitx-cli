import fs from 'node:fs';
import path from 'node:path';

// Making sense of what somebody typed after `.cat`, `.tree`, `.ls` or `.view`: the flag comes off
// it, then the filesystem is asked what is actually there. In lib/commands/repl/ rather than
// lib/repl/, because a `-L` flag and a prompt to refill are terminal facts — the engine has no
// idea these commands exist.

/** `-L 2`, anywhere in the argument, the way `tree` takes it. */
const DEPTH_FLAG = /(?:^|\s)-L\s*(\d+)(?:\s|$)/;

/**
 * The path a command was pointed at, and how deep it was asked to go.
 *
 * Two answers because the argument holds two things and every path command has to separate them
 * before it can do anything. `.` for nothing typed, since a path command with no path means here.
 *
 * ```ts
 * import { pathAndDepth } from './typed-path.ts';
 *
 * pathAndDepth('-L 2 lib'); // { file: 'lib', depth: 2 }
 * pathAndDepth('lib'); // { file: 'lib', depth: Infinity } — all the way down unless told otherwise
 * pathAndDepth(''); // { file: '.', depth: Infinity } — here
 * ```
 */
export function pathAndDepth(argument: string): { file: string; depth: number } {
  const depth = DEPTH_FLAG.exec(argument);
  const rest = argument.replace(DEPTH_FLAG, ' ').trim();

  return { file: rest === '' ? '.' : rest, depth: depth ? Number(depth[1]) : Infinity };
}

/**
 * What was at a typed path — one of four things, and never a thrown error.
 *
 * `prefill` is the part that does exist, which is what the prompt puts back so the next attempt
 * costs a few keystrokes rather than the whole path again. For a directory that is the path with a
 * slash on it; for a path that goes wrong halfway, the last directory that was real.
 */
export type FoundPath =
  | { kind: 'file'; contents: string }
  | { kind: 'directory'; prefill: string }
  | { kind: 'missing'; prefill: string }
  | { kind: 'unreadable'; detail: string };

/**
 * Asks the filesystem what a typed path is, and reads it where that is the answer.
 *
 * `findPath` and not `resolve`: `path.resolve` is imported in almost every file in this codebase
 * and does something else entirely, so `Files.resolve(…)` beside `path.resolve(…)` was two lines
 * apart and two different jobs. Nothing here throws — a command's job is to say what happened, and
 * every way this can go is a thing worth saying.
 *
 * ```ts
 * import { findPath } from './typed-path.ts';
 *
 * findPath('lib/nowhere.ts', process.cwd()); // { kind: 'missing', prefill: 'lib/' }
 * findPath('lib', process.cwd()); // { kind: 'directory', prefill: 'lib/' }
 * ```
 */
export function findPath(typed: string, cwd: string): FoundPath {
  const absolute = path.resolve(cwd, typed);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(absolute);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code !== 'ENOENT') return { kind: 'unreadable', detail: failure.message };

    return { kind: 'missing', prefill: realDirectoryPrefix(typed, cwd) };
  }
  if (stats.isDirectory()) {
    return { kind: 'directory', prefill: typed.endsWith('/') ? typed : `${typed}/` };
  }

  try {
    return { kind: 'file', contents: fs.readFileSync(absolute, 'utf8') };
  } catch (error) {
    return { kind: 'unreadable', detail: (error as Error).message };
  }
}

/** The longest leading run of `typed` that is a real directory, ending in a slash. */
function realDirectoryPrefix(typed: string, cwd: string): string {
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
