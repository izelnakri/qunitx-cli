import * as TAP from '../tap/index.ts';
import { failedAssertions } from './failure.ts';
import type { Reporter, RunStartInfo, RunEndInfo, TestDetails } from './types.ts';
import type { Config } from '../types.ts';

/**
 * The default reporter: streams TAP version 13 to stdout. Stateless — every number it
 * prints comes from `config.state.results.counter`, which the dispatcher updates before `onTestEnd`.
 *
 * ```ts
 * import type { Config } from '../types.ts';
 * import type { TestDetails } from './types.ts';
 *
 * // Defined, not invoked: streams TAP to stdout.
 * function example(config: Config, details: TestDetails) {
 *   const reporter = new TAPReporter();
 *   reporter.onRunStart(config, { fileCount: 2, groupCount: 1 }); // "TAP version 13"
 *   reporter.onTestEnd(config, details); // "ok 1 Math | adds # (2 ms)"
 *   reporter.onRunEnd(config, { durationMs: 900 }); // "1..1" plan + summary comments
 * }
 * ```
 */
export class TAPReporter implements Reporter {
  /**
   * Emits the TAP version header, plus the run banner as a `#` comment.
   *
   * ```ts
   * import type { Config } from '../types.ts';
   *
   * // Defined, not invoked: writes the TAP header to stdout.
   * function example(config: Config) {
   *   new TAPReporter().onRunStart(config, { fileCount: 2, groupCount: 1 });
   *   // "TAP version 13" then "# Running 2 test files across 1 group"
   * }
   * ```
   */
  onRunStart(config: Config, info: RunStartInfo): void {
    config.state.output.write('TAP version 13\n');
    // Watch mode emits the header per browser connection and has no file/group counts to
    // report at that point.
    if (info.fileCount === null) return;

    const daemon = config.state.daemon ? ' (daemon)' : '';
    if (info.fileCount === 0) {
      // No test files matched (e.g. --changed filtered everything out): emit a complete,
      // valid TAP document — header plus an empty plan — so parsers see a clean zero run.
      config.state.output.write(`# Running 0 test files${daemon}\n1..0\n`);
      return;
    }
    const files = `${info.fileCount} test file${info.fileCount === 1 ? '' : 's'}`;
    const groups = `${info.groupCount} group${info.groupCount === 1 ? '' : 's'}`;
    config.state.output.write(`# Running ${files} across ${groups}${daemon}\n`);
  }

  /**
   * Emits the `ok` / `not ok` line, with a YAML block for each failing assertion.
   *
   * ```ts
   * import type { Config } from '../types.ts';
   *
   * // Defined, not invoked: writes the test's TAP line to stdout.
   * function example(reporter: TAPReporter, config: Config) {
   *   reporter.onTestEnd(config, { status: 'passed', fullName: ['Math', 'adds'], runtime: 2 });
   *   // "ok 1 Math | adds # (2 ms)" — the number is config.state.results.counter.testCount
   * }
   * ```
   */
  onTestEnd(config: Config, details: TestDetails): void {
    // Only failed tests carry assertions — the injected runtime sends the trimmed
    // `{ status, fullName, runtime }` for every other status — so resolving failures for a
    // passing test is a call and an allocation that can never produce output. Guarding here
    // matches what every other reporter already does.
    const failures =
      details.status === 'failed'
        ? failedAssertions(details, config.state.group.sourceMapDecoder, config.projectRoot)
        : [];
    TAP.displayTestResult(
      config.state.results.counter.testCount,
      details,
      failures,
      config.state.output,
    );
  }

  /**
   * Emits the TAP plan line and the run summary.
   *
   * ```ts
   * import type { Config } from '../types.ts';
   *
   * // Defined, not invoked: writes the plan + summary to stdout.
   * function example(reporter: TAPReporter, config: Config) {
   *   reporter.onRunEnd(config, { durationMs: 900 }); // "1..12" then "# tests 12" …
   * }
   * ```
   */
  onRunEnd(config: Config, info: RunEndInfo): void {
    TAP.displayFinalResult(config.state.results.counter, info.durationMs, config.state.output);
  }
}
