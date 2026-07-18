/**
 * The qunitx JS/TS API — run your browser tests from code instead of the CLI.
 *
 * ```ts
 * import { run, search, watch } from 'qunitx-cli';
 *
 * const result = await run({ files: ['test/**\/*.ts'] });
 * console.log(result.counts, result.failures);
 * ```
 *
 * Nothing here touches the host process: no `process.exit`, no `process.exitCode`, no signal
 * handlers, no raw-mode stdin, and no output unless a `reporter` is requested. Every entry
 * point tears down the browser, server and esbuild context before it settles.
 */

export { run, type RunHandle } from './run.ts';
export { watch, type WatchSession } from './watch.ts';
export { search } from './search.ts';

export type {
  Assertion,
  BrowserName,
  CoverageSummary,
  DiscoveredTest,
  FileCoverageSummary,
  QunitxOptions,
  ReporterName,
  RunCounts,
  RunEvents,
  RunOptions,
  RunResult,
  RunStartInfo,
  SearchOptions,
  TestResult,
  TestStatus,
  WatchEvents,
  WatchOptions,
} from './types.ts';
