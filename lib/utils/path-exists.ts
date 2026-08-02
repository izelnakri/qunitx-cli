import fs from 'node:fs/promises';
import { Task } from '../task/index.ts';

/**
 * Returns `true` if the given filesystem path is accessible, `false` otherwise.
 *
 * ```ts
 * await pathExists('/tmp'); // true
 * await pathExists('/tmp/nonexistent-qunitx-file'); // false — any access failure reads as absent
 * ```
 *
 * `recover`, not `unwrapOr`: this is one of the few places the catch-all is the point. "Can I
 * reach it?" has no failure mode worth distinguishing — an ENOENT and an EACCES both mean the
 * caller cannot use the path.
 */
export function pathExists(path: string): Task<boolean, never> {
  return Task(() => fs.access(path))
    .map(() => true)
    .recover(() => false);
}
