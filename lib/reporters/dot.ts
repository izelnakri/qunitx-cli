import { green, red, yellow } from '../utils/color.ts';
import { failedAssertions } from './failure.ts';
import { formatFailureBlock } from './spec.ts';
import { indentString } from '../utils/indent-string.ts';
import type { Reporter, RunStartInfo, RunEndInfo, TestDetails, ReporterContext } from './types.ts';

/** Dots per line before wrapping — comfortably inside an 80-column terminal. */
const LINE_WIDTH = 72;

/**
 * One character per test, failures reported in full at the end. The right shape for large
 * suites and CI logs, where a line per test is thousands of lines of noise but you still
 * want live progress.
 *
 * Unlike spec, failure detail is buffered rather than printed inline — interleaving failure
 * blocks with the dot matrix would break the matrix apart and lose the at-a-glance shape.
 *
 * ```ts
 * import type { ReporterContext } from './types.ts';
 *
 * import type { TestDetails } from './types.ts';
 *
 * // Defined, not invoked: streams the dot matrix to stdout.
 * function example(context: ReporterContext, details: TestDetails) {
 *   const reporter = new DotReporter();
 *   reporter.onRunStart(context, { fileCount: 3, groupCount: 2 });
 *   reporter.onTestEnd(context, details); // one character per test: . F t s
 *   reporter.onRunEnd(context, { durationMs: 1200 }); // counts + buffered failure blocks
 * }
 * ```
 */
export class DotReporter implements Reporter {
  #column = 0;
  #failures: Array<{ name: string; block: string }> = [];

  /**
   * Resets the matrix column and buffered failures, then prints the run banner.
   *
   * ```ts
   * import type { ReporterContext } from './types.ts';
   *
   * // Defined, not invoked: prints the banner to stdout.
   * function example(context: ReporterContext) {
   *   new DotReporter().onRunStart(context, { fileCount: 3, groupCount: 2 });
   *   // "Running 3 test files across 2 worker(s)"
   * }
   * ```
   */
  onRunStart(context: ReporterContext, info: RunStartInfo): void {
    this.#column = 0;
    this.#failures = [];
    if (info.fileCount === null) return;
    if (info.fileCount === 0) {
      context.console.log('\nNo test files found.\n');
      return;
    }
    const files = `${info.fileCount} test file${info.fileCount === 1 ? '' : 's'}`;
    context.console.log(`\nRunning ${files} across ${info.groupCount} worker(s)\n\n`);
  }

  /**
   * Writes this test's character, wrapping the matrix, and buffers any failure detail.
   *
   * ```ts
   * import type { ReporterContext } from './types.ts';
   *
   * // Defined, not invoked: writes one status character to stdout.
   * function example(reporter: DotReporter, context: ReporterContext) {
   *   reporter.onTestEnd(context, { status: 'passed', fullName: ['Math', 'adds'], runtime: 2 }); // '.'
   *   reporter.onTestEnd(context, { status: 'skipped', fullName: ['Math', 'later'], runtime: 0 }); // 's'
   * }
   * ```
   */
  onTestEnd(context: ReporterContext, details: TestDetails): void {
    // Dot and any wrap in one write: this runs per test, and a split write invites another
    // group's output between the character and its own newline.
    const wrapped = ++this.#column >= LINE_WIDTH;
    if (wrapped) this.#column = 0;
    context.console.log(wrapped ? `${statusDot(details.status)}\n` : statusDot(details.status));

    if (details.status !== 'failed') return;
    this.#failures.push({
      name: details.fullName.join(' | '),
      block: formatFailureBlock(
        failedAssertions(details, context.sourceMapDecoder, context.projectRoot),
      ),
    });
  }

  /**
   * Closes the matrix line, then prints the counts and every buffered failure.
   *
   * ```ts
   * import type { ReporterContext } from './types.ts';
   *
   * // Defined, not invoked: reads context.counts and writes to stdout.
   * function example(reporter: DotReporter, context: ReporterContext) {
   *   reporter.onRunEnd(context, { durationMs: 1200 }); // "  12 passing (1200ms)" + failure recap
   * }
   * ```
   */
  onRunEnd(context: ReporterContext, info: RunEndInfo): void {
    const { passed, failed, skipped, todo } = context.counts;
    // Zero counts stay off the summary — "0 failing" is noise on a green run.
    const counts = [
      `\n  ${green(`${passed} passing`)} (${info.durationMs}ms)`,
      ...(failed > 0 ? [`  ${red(`${failed} failing`)}`] : []),
      ...(skipped > 0 ? [`  ${yellow(`${skipped} skipped`)}`] : []),
      ...(todo > 0 ? [`  ${yellow(`${todo} todo`)}`] : []),
    ].join('\n');

    const recap = this.#failures.length
      ? `\n${red('Failures:')}\n${this.#failures
          .map(
            ({ name, block }, index) =>
              `\n  ${index + 1}) ${name}\n${block ? indentString(block, 5) : ''}`,
          )
          .join('')}`
      : '';

    // Leading newline closes the dot matrix when it ends mid-line.
    context.console.log(`${this.#column > 0 ? '\n' : ''}${counts}\n${recap}\n`);
  }
}

// Built once: `color.ts` freezes its enabled/disabled decision at module load, so precomputing
// costs nothing and can't drift from a call-time green()/red().
const DOTS: Record<string, string> = { passed: green('.'), failed: red('F'), todo: yellow('t') };

function statusDot(status: string): string {
  return DOTS[status] ?? yellow('s'); // anything else (skipped) is an 's'
}
