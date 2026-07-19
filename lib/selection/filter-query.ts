import path from 'node:path';
import type { Config } from '../types.ts';

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
 */
export function qunitFilterQuery(config: FilterConfig): string {
  if (!config.filter) {
    return '';
  }
  // URLSearchParams encodes spaces as '+', which is exactly what QUnit's decodeQueryParam
  // turns back into a space before decodeURIComponent.
  const params = new URLSearchParams();
  params.set('filter', config.filter);

  return `?${params.toString()}`;
}

/** Human-readable description of the active filters, for the "nothing matched" message. */
export function describeFilter(config: FilterConfig): string {
  const parts: string[] = [];
  if (config.filter) {
    parts.push(`--filter=${config.filter}`);
  }
  for (const [file, lines] of Object.entries(config.lineTargets ?? {})) {
    parts.push(lines.map((line) => `${path.basename(file)}#${line}`).join(' '));
  }

  return parts.join(' ');
}
