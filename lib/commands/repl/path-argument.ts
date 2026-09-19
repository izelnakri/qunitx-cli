import fs from 'node:fs';
import path from 'node:path';

// The two steps every path command takes before it can do anything: the flag comes off the
// argument, then the filesystem is asked what is actually at what is left. Both operate on the
// same thing — the path argument a command was handed — which is what makes them one module and
// what the file is named after.
//
// Not `path-utils.ts`: "utils" is the word that let `files.ts`, `values.ts` and `paths.ts` each
// become three unrelated jobs, because nothing named utils can ever be the wrong place for a new
// function. Not `path-argument.ts` either, which reads as "a path with a type" in a TypeScript file.
//
// In lib/commands/repl/ rather than lib/repl/, because a `-L` flag and a prompt to refill are
// terminal facts — the engine has no idea these commands exist.

/** `-L 2`, anywhere in the argument, the way `tree` takes it. */
const DEPTH_FLAG = /(?:^|\s)-L\s*(\d+)(?:\s|$)/;

/**
 * The path a command was pointed at, and how deep it was asked to go.
 *
 * Two answers because the argument holds two things and every path command has to separate them
 * before it can do anything. `.` for nothing typed, since a path command with no path means here.
 *
 * ```ts
 * import { getPathAndDepth } from './path-argument.ts';
 *
 * getPathAndDepth('-L 2 lib'); // { file: 'lib', depth: 2 }
 * getPathAndDepth('lib'); // { file: 'lib', depth: Infinity } — all the way down unless told otherwise
 * getPathAndDepth(''); // { file: '.', depth: Infinity } — here
 * ```
 */
export function getPathAndDepth(argument: string): { file: string; depth: number } {
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
  // No contents: `.view` asks what is there and then hands the whole thing to `.cat`, so reading
  // here meant reading the file twice for one `.view`. Whoever wants the bytes asks for them.
  | { kind: 'file' }
  | { kind: 'directory'; prefill: string }
  | { kind: 'missing'; prefill: string }
  | { kind: 'unreadable'; detail: string };

/**
 * Asks the filesystem what is at a typed path — one of four answers, and never a thrown error.
 *
 * `findPath` and not `resolve`: `path.resolve` is imported in almost every file in this codebase
 * and does something else entirely, so `Files.resolve(…)` beside `path.resolve(…)` was two lines
 * apart and two different jobs. Grepping for callers of one found ninety files using the other.
 *
 * Synchronous on purpose, and measured: `statSync` is 0.0018ms against `fs.promises.stat`'s
 * 0.0265ms — fourteen times, because async goes through libuv's thread pool — and the prefill walk
 * does one per path segment. There is nothing to overlap it with either: one path, one command,
 * somebody waiting at a prompt. Going async would also drag `.cat` and `.tree` from synchronous
 * `main`s to asynchronous ones for no gain at all.
 *
 * Nothing here can be replaced by a line or two of plain `fs`: three of the four answers are, but
 * `prefill` is a walk up the path looking for the longest run that is a real directory, and it is
 * what makes a mistyped path cost a few keystrokes instead of all of them.
 *
 * ```ts
 * import { findPath } from './path-argument.ts';
 *
 * findPath('lib/nowhere.ts', process.cwd()); // { kind: 'missing', prefill: 'lib/' }
 * findPath('lib', process.cwd()); // { kind: 'directory', prefill: 'lib/' }
 * ```
 */
export function findPath(typed: string, cwd: string): FoundPath {
  let stats: fs.Stats | undefined;
  try {
    // `throwIfNoEntry: false` so the ordinary answer — there is nothing there — is a value rather
    // than an exception. What is left in the catch is a real problem: a permission, a broken mount.
    stats = fs.statSync(path.resolve(cwd, typed), { throwIfNoEntry: false });
  } catch (error) {
    return { kind: 'unreadable', detail: (error as Error).message };
  }
  if (stats === undefined) return { kind: 'missing', prefill: realDirectoryPrefix(typed, cwd) };
  if (stats.isDirectory()) {
    return { kind: 'directory', prefill: typed.endsWith('/') ? typed : `${typed}/` };
  }

  return { kind: 'file' };
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
