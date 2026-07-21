import path from 'node:path';
import { pathExists } from './path-exists.ts';

/**
 * Recursively searches `directory` and its ancestors for a file or folder named `targetEntry`; returns the absolute path or `undefined`.
 * @returns {Promise<string|undefined>}
 */
export async function searchInParentDirectories(
  directory: string,
  targetEntry: string,
): Promise<string | undefined> {
  const resolvedDirectory = directory === '.' ? process.cwd() : directory;

  const candidate = path.join(resolvedDirectory, targetEntry);
  if (await pathExists(candidate)) return candidate;

  // path.dirname returns the same path when at the filesystem root (e.g. '/' or 'C:\\'),
  // which is the loop terminator. The previous `lastIndexOf('/')` walked one character
  // at a time on Windows because backslash never matched, then bottomed out at -1
  // (slice(0,-1) drops just the last char) instead of recognizing the root.
  const parent = path.dirname(resolvedDirectory);
  if (parent === resolvedDirectory) return;

  return searchInParentDirectories(parent, targetEntry);
}
