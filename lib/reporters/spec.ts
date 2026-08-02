import { green, red, yellow, blue } from '../utils/color.ts';
import * as Result from '../result/index.ts';
import { failedAssertions, type FailureInfo } from './failure.ts';
import { indentString } from '../utils/indent-string.ts';
import type { Reporter, RunStartInfo, RunEndInfo, TestDetails } from './types.ts';
import type { Config } from '../types.ts';

/**
 * Human-readable reporter: tests nested under their QUnit module, with failures shown inline
 * where they happen. The shape Node, Vitest and Mocha all default to — raw TAP is a poor
 * local-dev experience.
 *
 * Module headers are printed on change rather than buffered to the end, so output streams.
 * Under concurrent groups the testEnd events interleave, so a module header can legitimately
 * reappear — that reflects what actually ran, and beats withholding output until the run ends.
 *
 * ```ts
 * import type { Config } from '../types.ts';
 * import type { TestDetails } from './types.ts';
 *
 * // Defined, not invoked: streams the nested spec view to stdout.
 * function example(config: Config, details: TestDetails) {
 *   const reporter = new SpecReporter();
 *   reporter.onRunStart(config, { fileCount: 1, groupCount: 1 });
 *   reporter.onTestEnd(config, details); // "  ✔ adds (2ms)" under its module header
 *   reporter.onRunEnd(config, { durationMs: 350 });
 * }
 * ```
 */
export class SpecReporter implements Reporter {
  #lastModule: string | null = null;
  #failures: string[] = [];

  /**
   * Resets per-run state and prints the run banner.
   *
   * ```ts
   * import type { Config } from '../types.ts';
   *
   * // Defined, not invoked: prints the banner to stdout.
   * function example(config: Config) {
   *   new SpecReporter().onRunStart(config, { fileCount: 3, groupCount: 2 });
   *   // "Running 3 test files across 2 worker(s)"
   * }
   * ```
   */
  onRunStart(_config: Config, info: RunStartInfo): void {
    this.#lastModule = null;
    this.#failures = [];
    if (info.fileCount === null) return;
    if (info.fileCount === 0) {
      process.stdout.write('\nNo test files found.\n');
      return;
    }
    const files = `${info.fileCount} test file${info.fileCount === 1 ? '' : 's'}`;
    process.stdout.write(`\nRunning ${files} across ${info.groupCount} worker(s)\n`);
  }

  /**
   * Prints the module header when it changes, then this test's result line.
   *
   * ```ts
   * import type { Config } from '../types.ts';
   *
   * // Defined, not invoked: writes the header + result line to stdout.
   * function example(reporter: SpecReporter, config: Config) {
   *   reporter.onTestEnd(config, { status: 'passed', fullName: ['Math', 'adds'], runtime: 2 });
   *   // "Math" (only when the module changed) then "  ✔ adds (2ms)"
   * }
   * ```
   */
  onTestEnd(config: Config, details: TestDetails): void {
    const moduleName = details.fullName.slice(0, -1).join(' > ') || '(root)';
    // Header only when the module changes; under concurrent groups it can legitimately repeat.
    const header = moduleName === this.#lastModule ? '' : `\n${blue(moduleName)}\n`;
    this.#lastModule = moduleName;
    const line = `  ${statusMark(details.status)} ${details.fullName.at(-1) ?? ''}${duration(details)}\n`;

    if (details.status !== 'failed') {
      process.stdout.write(header + line);
      return;
    }

    // Header, result and failure block in one write — this runs per test, and a split write
    // lets a concurrent group's line land between a test and its own failure detail.
    const block = formatFailureBlock(
      failedAssertions(details, config.state.group.sourceMapDecoder, config.projectRoot),
    );
    process.stdout.write(header + line + (block ? indentString(block, 4) : ''));
    // Remember the headline for the end-of-run recap so a failure buried thousands of lines
    // up is still actionable.
    this.#failures.push(details.fullName.join(' | '));
  }

  /**
   * Prints the outcome counts and, when any test failed, the failure recap.
   *
   * ```ts
   * import type { Config } from '../types.ts';
   *
   * // Defined, not invoked: reads config.state.results.counter and writes to stdout.
   * function example(reporter: SpecReporter, config: Config) {
   *   reporter.onRunEnd(config, { durationMs: 350 });
   *   // "  4 passing (350ms)" plus a numbered "Failures:" recap when anything failed
   * }
   * ```
   */
  onRunEnd(config: Config, info: RunEndInfo): void {
    const { passCount, failCount, skipCount, todoCount } = config.state.results.counter;
    // Zero counts stay off the summary — "0 failing" is noise on a green run.
    const counts = [
      `\n  ${green(`${passCount} passing`)} (${info.durationMs}ms)`,
      ...(failCount > 0 ? [`  ${red(`${failCount} failing`)}`] : []),
      ...(skipCount > 0 ? [`  ${yellow(`${skipCount} skipped`)}`] : []),
      ...(todoCount > 0 ? [`  ${yellow(`${todoCount} todo`)}`] : []),
    ].join('\n');

    const recap = this.#failures.length
      ? `\n${red('Failures:')}\n${this.#failures.map((name, index) => `  ${index + 1}) ${name}`).join('\n')}\n`
      : '';

    process.stdout.write(`${counts}\n${recap}\n`);
  }
}

/**
 * Renders every failing assertion of one test: message, values, and source location.
 *
 * ```ts
 * formatFailureBlock([
 *   { index: 1, message: 'bad sum', actual: 3, expected: 4, stack: null, at: 'lib/math.ts:4:3', source: null },
 * ]);
 * // 'bad sum\nexpected: 4\nactual:   3\nat lib/math.ts:4:3\n' (message red on a TTY)
 * formatFailureBlock([]); // ''
 * ```
 */
export function formatFailureBlock(failures: FailureInfo[]): string {
  if (failures.length === 0) return '';
  return (
    failures
      .map((failure) =>
        [
          red(failure.message ?? `Assertion #${failure.index} failed`),
          // Values only when they carry signal — a bare `ok()` has neither.
          ...(failure.expected !== undefined || failure.actual !== undefined
            ? [`expected: ${format(failure.expected)}`, `actual:   ${format(failure.actual)}`]
            : []),
          ...(failure.source ? [`source:   ${failure.source}`] : []),
          ...(failure.at ? [`at ${failure.at}`] : []),
        ].join('\n'),
      )
      .join('\n\n') + '\n'
  );
}

// Built once: `color.ts` freezes its enabled/disabled decision at module load.
const MARKS: Record<string, string> = {
  passed: green('✔'),
  failed: red('✖'),
  todo: yellow('◌'),
};

function statusMark(status: string): string {
  return MARKS[status] ?? yellow('-'); // anything else (skipped) is a dash
}

// Skipped/todo tests never ran, so a "(0ms)" suffix on them is noise.
function duration(details: TestDetails): string {
  if (details.status === 'skipped' || details.status === 'todo') return '';
  return ` (${details.runtime.toFixed(0)}ms)`;
}

function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  // A circular structure is the case this exists for; String(value) is what a reporter can
  // still print. Narrowed to the stringify so a bug in this function is not also swallowed.
  const json = Result.try(() => JSON.stringify(value));
  return json.ok ? (json.value ?? String(value)) : String(value);
}
