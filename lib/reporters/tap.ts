import * as TAP from '../tap/index.ts';
import { failedAssertions } from './failure.ts';
import type { Reporter, RunStartInfo, RunEndInfo, TestDetails, ReporterContext } from './types.ts';

/**
 * The default reporter: streams TAP version 13 to stdout. Stateless — every number it
 * prints comes from `context.counts`, which the dispatcher updates before `onTestEnd`.
 *
 * ```ts
 * import type { ReporterContext } from './types.ts';
 *
 * import type { TestDetails } from './types.ts';
 *
 * // Defined, not invoked: streams TAP to stdout.
 * function example(context: ReporterContext, details: TestDetails) {
 *   const reporter = new TAPReporter();
 *   reporter.onRunStart(context, { fileCount: 2, groupCount: 1 }); // "TAP version 13"
 *   reporter.onTestEnd(context, details); // "ok 1 Math | adds # (2 ms)"
 *   reporter.onRunEnd(context, { durationMs: 900 }); // "1..1" plan + summary comments
 * }
 * ```
 */
export class TAPReporter implements Reporter {
  /**
   * Emits the TAP version header, plus the run banner as a `#` comment.
   *
   * ```ts
   * import type { ReporterContext } from './types.ts';
   *
   * // Defined, not invoked: writes the TAP header to stdout.
   * function example(context: ReporterContext) {
   *   new TAPReporter().onRunStart(context, { fileCount: 2, groupCount: 1 });
   *   // "TAP version 13" then "# Running 2 test files across 1 group"
   * }
   * ```
   */
  onRunStart(context: ReporterContext, info: RunStartInfo): void {
    context.console.log('TAP version 13\n');
    // Watch mode emits the header per browser connection and has no file/group counts to
    // report at that point.
    if (info.fileCount === null) return;

    const daemon = context.daemon ? ' (daemon)' : '';
    if (info.fileCount === 0) {
      // No test files matched (e.g. --changed filtered everything out): emit a complete,
      // valid TAP document — header plus an empty plan — so parsers see a clean zero run.
      context.console.log(`# Running 0 test files${daemon}\n1..0\n`);
      return;
    }
    const files = `${info.fileCount} test file${info.fileCount === 1 ? '' : 's'}`;
    const groups = `${info.groupCount} group${info.groupCount === 1 ? '' : 's'}`;
    context.console.log(`# Running ${files} across ${groups}${daemon}\n`);
  }

  /**
   * Emits the `ok` / `not ok` line, with a YAML block for each failing assertion.
   *
   * ```ts
   * import type { ReporterContext } from './types.ts';
   *
   * // Defined, not invoked: writes the test's TAP line to stdout.
   * function example(reporter: TAPReporter, context: ReporterContext) {
   *   reporter.onTestEnd(context, { status: 'passed', fullName: ['Math', 'adds'], runtime: 2 });
   *   // "ok 1 Math | adds # (2 ms)" — the number is context.counts.total
   * }
   * ```
   */
  onTestEnd(context: ReporterContext, details: TestDetails): void {
    // Only failed tests carry assertions — the injected runtime sends the trimmed
    // `{ status, fullName, runtime }` for every other status — so resolving failures for a
    // passing test is a call and an allocation that can never produce output. Guarding here
    // matches what every other reporter already does.
    const failures =
      details.status === 'failed'
        ? failedAssertions(details, context.sourceMapDecoder, context.projectRoot)
        : [];
    TAP.displayTestResult(context.counts.total, details, failures, context.console);
  }

  /**
   * Emits the TAP plan line and the run summary.
   *
   * ```ts
   * import type { ReporterContext } from './types.ts';
   *
   * // Defined, not invoked: writes the plan + summary to stdout.
   * function example(reporter: TAPReporter, context: ReporterContext) {
   *   reporter.onRunEnd(context, { durationMs: 900 }); // "1..12" then "# tests 12" …
   * }
   * ```
   */
  onRunEnd(context: ReporterContext, info: RunEndInfo): void {
    TAP.displayFinalResult(context.counts, info.durationMs, context.console);
  }
}
