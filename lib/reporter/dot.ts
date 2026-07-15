import { green, red, yellow } from '../utils/color.ts';
import { failedAssertions } from './failure.ts';
import { formatFailureBlock } from './spec.ts';
import { indentString } from '../utils/indent-string.ts';
import type { Reporter, RunStartInfo, RunEndInfo, TestDetails } from './types.ts';
import type { Config } from '../types.ts';

/** Dots per line before wrapping — comfortably inside an 80-column terminal. */
const LINE_WIDTH = 72;

/**
 * One character per test, failures reported in full at the end. The right shape for large
 * suites and CI logs, where a line per test is thousands of lines of noise but you still
 * want live progress.
 *
 * Unlike spec, failure detail is buffered rather than printed inline — interleaving failure
 * blocks with the dot matrix would break the matrix apart and lose the at-a-glance shape.
 */
export class DotReporter implements Reporter {
  #column = 0;
  #failures: Array<{ name: string; block: string }> = [];

  /** Resets the matrix column and buffered failures, then prints the run banner. */
  onRunStart(_config: Config, info: RunStartInfo): void {
    this.#column = 0;
    this.#failures = [];
    if (info.fileCount === null) return;
    if (info.fileCount === 0) {
      process.stdout.write('\nNo test files found.\n');
      return;
    }
    const files = `${info.fileCount} test file${info.fileCount === 1 ? '' : 's'}`;
    process.stdout.write(`\nRunning ${files} across ${info.groupCount} worker(s)\n\n`);
  }

  /** Writes this test's character, wrapping the matrix, and buffers any failure detail. */
  onTestEnd(config: Config, details: TestDetails): void {
    // Dot and any wrap in one write: this runs per test, and a split write invites another
    // group's output between the character and its own newline.
    const wrapped = ++this.#column >= LINE_WIDTH;
    if (wrapped) this.#column = 0;
    process.stdout.write(wrapped ? `${statusDot(details.status)}\n` : statusDot(details.status));

    if (details.status !== 'failed') return;
    this.#failures.push({
      name: details.fullName.join(' | '),
      block: formatFailureBlock(
        failedAssertions(details, config._sourceMapDecoder, config.projectRoot),
      ),
    });
  }

  /** Closes the matrix line, then prints the counts and every buffered failure. */
  onRunEnd(config: Config, info: RunEndInfo): void {
    const { passCount, failCount, skipCount, todoCount } = config.COUNTER;
    // Zero counts stay off the summary — "0 failing" is noise on a green run.
    const counts = [
      `\n  ${green(`${passCount} passing`)} (${info.durationMs}ms)`,
      ...(failCount > 0 ? [`  ${red(`${failCount} failing`)}`] : []),
      ...(skipCount > 0 ? [`  ${yellow(`${skipCount} skipped`)}`] : []),
      ...(todoCount > 0 ? [`  ${yellow(`${todoCount} todo`)}`] : []),
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
    process.stdout.write(`${this.#column > 0 ? '\n' : ''}${counts}\n${recap}\n`);
  }
}

// Built once: `color.ts` freezes its enabled/disabled decision at module load, so precomputing
// costs nothing and can't drift from a call-time green()/red().
const DOTS: Record<string, string> = { passed: green('.'), failed: red('F'), todo: yellow('t') };

function statusDot(status: string): string {
  return DOTS[status] ?? yellow('s'); // anything else (skipped) is an 's'
}
