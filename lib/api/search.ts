import * as Search from '../commands/search.ts';
import { Task } from '../task/index.ts';
import * as Options from './options.ts';
import * as Config from '../setup/config.ts';
import type { RunFailure } from './test.ts';
import type { SearchReport as SearchResult } from '../commands/search.ts';
import type { UserRunOptions } from './options.ts';

/**
 * What `search()` found, and one match in it.
 *
 * The scan's own types, not re-shaped copies: `Search.scan` already produces exactly this — a
 * structured `modules` path and a numeric `line` — so the API publishes it rather than
 * transcribing it into a second set of identical interfaces.
 *
 * ```ts
 * const unlistable = { total: 0, computedNames: 0, unparseable: 0, silent: 0 };
 * const result: SearchResult =
 *   { matches: [], total: 12, files: 3, filter: 'Cart', warnings: [], unlistable };
 * result.matches.length; // 0 of 12 — nothing matched
 * ```
 */
export type { UnlistableCounts } from '../commands/search.ts';
export type { FoundTest as SearchMatch, SearchReport as SearchResult } from '../commands/search.ts';

/**
 * Lists the tests a selection would run, without running them.
 *
 * No browser, no bundle, no execution — the answer comes from parsing the declarations, so it
 * returns in milliseconds even for a large suite. The same scanner `file.ts#34` line targets
 * use, and the same filter matcher a real run applies, so the preview is what would actually be
 * selected.
 *
 * ```ts
 * import { search } from './search.ts';
 *
 * // Defined, not invoked: reads and parses the project's test files.
 * async function whatMatches() {
 *   const { matches } = await search({ filter: 'Cart' });
 *   return matches.map((one) => `${one.fullName}  ${one.file}#${one.line}`);
 * }
 * ```
 */
export function search(
  options: UserRunOptions | string | string[] = {},
): Task<SearchResult, RunFailure> {
  return Task(async () => {
    const config = await Config.setup(Options.from(options));

    return await Search.scan(config);
  });
}
