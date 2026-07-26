import path from 'node:path';
import type { Config } from '../types.ts';

/**
 * The slice of {@link Config} the filter helpers read — every function below takes this
 * rather than a full Config, so callers with only the three fields qualify.
 *
 * ```ts
 * import type { Config } from '../types.ts';
 *
 * type FilterConfig = Pick<Config, 'filter' | 'lineTargets' | 'state'>;
 * const expression: FilterConfig['filter'] = '/^Cart(:| >)/'; // the exact-module recipe
 * ```
 */
type FilterConfig = Pick<Config, 'filter' | 'lineTargets' | 'state'>;

/**
 * True when this run selects a subset of the tests *inside* the files it loads.
 *
 * File-level narrowing (`--only-failed`, `--changed`) does not count: those run whole files, so
 * their timings stay representative and their failure set is complete for the files they ran.
 * A test-level filter breaks both, which is why the timing and failure caches skip filtered runs.
 *
 * `lineTargets` counts even before it resolves to selectors — it is read on the parent config,
 * where per-group selectors are not visible.
 *
 * ```ts
 * import * as RunState from '../setup/run-state.ts';
 *
 * const state = RunState.create();
 * isFilteredRun({ state }); // false — whole files, caches stay valid
 * isFilteredRun({ filter: 'cart', state }); // true — a test-level subset
 * ```
 */
export function isFilteredRun(config: FilterConfig): boolean {
  return Boolean(
    config.filter ||
    config.state.group.selectors?.length ||
    (config.lineTargets && Object.keys(config.lineTargets).length),
  );
}

/**
 * Builds the `?filter=…` query that carries the test filter (`-t`/`--filter`/`-m`/`--module`)
 * into the page.
 *
 * This is the only channel that works: QUnit evaluates `config.filter` at test *declaration*
 * time, and its html-reporter block unconditionally overwrites `config.filter` from
 * `location.search` at bundle-eval time — so a preconfig global would be clobbered.
 * Returns '' when no filter is set, leaving URLs byte-identical to before.
 *
 * ```ts
 * import * as RunState from '../setup/run-state.ts';
 *
 * const state = RunState.create();
 * buildQUnitFilterQuery({ filter: 'cart checkout', state }); // '?filter=cart+checkout'
 * buildQUnitFilterQuery({ state }); // '' — URL byte-identical to an unfiltered run
 * ```
 */
export function buildQUnitFilterQuery(config: FilterConfig): string {
  if (!config.filter) {
    return '';
  }
  // URLSearchParams encodes spaces as '+', which is exactly what QUnit's decodeQueryParam
  // turns back into a space before decodeURIComponent.
  const params = new URLSearchParams();
  params.set('filter', config.filter);

  return `?${params.toString()}`;
}

/**
 * Human-readable description of the active filters, for the "nothing matched" message.
 *
 * ```ts
 * import * as RunState from '../setup/run-state.ts';
 *
 * const state = RunState.create();
 * describeActiveFilters({ filter: 'cart', lineTargets: { '/proj/cart-test.ts': [34, 60] }, state });
 * // '--filter=cart cart-test.ts#34 cart-test.ts#60'
 * ```
 */
export function describeActiveFilters(config: FilterConfig): string {
  const parts: string[] = [];
  if (config.filter) {
    parts.push(`--filter=${config.filter}`);
  }
  for (const [file, lines] of Object.entries(config.lineTargets ?? {})) {
    parts.push(lines.map((line) => `${path.basename(file)}#${line}`).join(' '));
  }

  return parts.join(' ');
}
