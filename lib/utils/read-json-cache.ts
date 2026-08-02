import fs from 'node:fs/promises';
import { Task } from '../task/index.ts';

/**
 * Reads a JSON cache file and hands back its contents, or `null`.
 *
 * A cache has exactly one failure mode from its caller's point of view — a miss — and four ways
 * to reach it: the file is absent, unreadable, torn, or written by a version whose shape no
 * longer matches. Each of this project's caches used to spell all four out for itself; they now
 * say only what a valid one looks like, and the answer to everything else lives here once.
 *
 * `recover`, not `unwrapOr`: a miss is not a *declared* failure, it is the absence of one, so
 * there is nothing to declare and nothing for a caller to discriminate.
 *
 * ```ts
 * import { readJsonCache } from './read-json-cache.ts';
 *
 * const isPortMap = (value: unknown): value is Record<string, number> =>
 *   typeof value === 'object' && value !== null && !Array.isArray(value);
 *
 * await readJsonCache('/no/such/cache.json', isPortMap); // null — a missing cache is a miss
 * ```
 */
export function readJsonCache<T>(
  filePath: string,
  isValid: (parsed: unknown) => parsed is T,
): Task<T | null, never> {
  return Task(() => fs.readFile(filePath, 'utf8'))
    .map((raw): T | null => {
      const parsed: unknown = JSON.parse(raw);
      return isValid(parsed) ? parsed : null;
    })
    .recover(() => null);
}
