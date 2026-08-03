import * as Config from '../setup/config.ts';
import * as Search from '../commands/search.ts';
import { Task } from '../task/index.ts';
import { unwrap } from '../result/result.ts';
import {
  normalizeOptions,
  resolveReporting,
  toConfigOptions,
  validate,
  type RunOptions,
} from './options.ts';
import type { RunFailure } from './run.ts';

/**
 * One test the static scan found.
 *
 * ```ts
 * const match: SearchMatch = {
 *   fullName: 'Cart > Coupons: applies code',
 *   name: 'applies code',
 *   modules: ['Cart', 'Coupons'],
 *   file: '/proj/test/cart-test.ts',
 *   line: 6,
 * };
 * `${match.file}#${match.line}`; // paste it straight back as a line target
 * ```
 */
export interface SearchMatch {
  /** `"Module > Sub: test name"` — the string `filter` matches against. */
  fullName: string;
  /** The test's own name. */
  name: string;
  /** The QUnit module path it is declared under; empty for a top-level test. */
  modules: string[];
  /** Absolute path of the file it is declared in. */
  file: string;
  /** 1-based line of the declaration. */
  line: number;
}

/**
 * What `search()` found.
 *
 * ```ts
 * const result: SearchResult =
 *   { matches: [], total: 12, files: 3, filter: 'Cart', warnings: [], unlistable: 0 };
 * result.matches.length; // 0 of 12 — nothing matched
 * ```
 */
export interface SearchResult {
  /** The matching tests, in declaration order. */
  matches: SearchMatch[];
  /** Every listable test in the scanned files, matched or not. */
  total: number;
  /** How many files were scanned. */
  files: number;
  /** The expression matched against, or `undefined` when everything was listed. */
  filter?: string;
  /** Line-target resolution warnings. */
  warnings: string[];
  /**
   * Declarations the scan could not name: a runtime-computed name (``test(`case ${i}`)``), an
   * unparseable file, or a declarator reached through a local alias. They may still match at
   * run time — a non-zero count means `total` is a lower bound.
   */
  unlistable: number;
}

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
 *   return matches.map((test) => `${test.fullName}  ${test.file}#${test.line}`);
 * }
 * ```
 */
export function search(
  options: RunOptions | string | string[] = {},
): Task<SearchResult, RunFailure> {
  return Task(async () => {
    const resolved = normalizeOptions(options);
    validate(resolved);
    const reporting = resolveReporting(resolved);
    const config = unwrap(await Config.setup(toConfigOptions(resolved, reporting)).result());
    const report = await Search.scan(config);

    return {
      matches: report.matches.map((match) => ({
        fullName: match.fullName,
        name: match.testName,
        modules: match.module === '' ? [] : match.module.split(' > '),
        file: match.file,
        // `location` is the display path plus `#line`; the line is what a caller can act on, and
        // `file` already carries the absolute path in a form they can pass straight back in.
        line: Number(match.location.slice(match.location.lastIndexOf('#') + 1)),
      })),
      total: report.total,
      files: report.files,
      filter: report.filter,
      warnings: report.warnings,
      unlistable: report.computedNames + report.unparseable + report.silent,
    };
  });
}
