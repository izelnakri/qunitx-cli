import { SpecReporter } from './spec.ts';
import * as Result from '../result/index.ts';
import { failedAssertions, parseAt, type FailureInfo } from './failure.ts';
import type { Reporter, RunStartInfo, RunEndInfo, TestDetails } from './types.ts';
import type { Config } from '../types.ts';

/**
 * GitHub Actions reporter: spec output, plus a `::error` workflow command per failure so the
 * failure is annotated inline on the PR diff.
 *
 * Getting annotations otherwise costs an artifact upload, a second workflow, a third-party
 * reporter action, and a fork-token dance. Here it's one flag — the file:line is already
 * resolved back to original sources by the shared failure descriptor.
 *
 * Composes SpecReporter rather than reimplementing it: the log stays as readable as a normal
 * spec run, and annotations are strictly additional.
 *
 * ```ts
 * import type { Config } from '../types.ts';
 * import type { TestDetails } from './types.ts';
 *
 * // Defined, not invoked: streams spec output plus ::error commands to stdout.
 * function example(config: Config, details: TestDetails) {
 *   const reporter = new GithubReporter();
 *   reporter.onRunStart(config, { fileCount: 1, groupCount: 1 });
 *   reporter.onTestEnd(config, details); // spec line, plus "::error …" per failing assertion
 *   reporter.onRunEnd(config, { durationMs: 800 });
 * }
 * ```
 */
export class GithubReporter implements Reporter {
  #spec = new SpecReporter();

  /**
   * Delegates the run banner to the spec renderer.
   *
   * ```ts
   * import type { Config } from '../types.ts';
   *
   * // Defined, not invoked: prints the banner to stdout.
   * function example(reporter: GithubReporter, config: Config) {
   *   reporter.onRunStart(config, { fileCount: 2, groupCount: 1 }); // "Running 2 test files …"
   * }
   * ```
   */
  onRunStart(config: Config, info: RunStartInfo): void {
    this.#spec.onRunStart(config, info);
  }

  /**
   * Renders the spec line, then annotates each failing assertion for the PR diff.
   *
   * ```ts
   * import type { Config } from '../types.ts';
   * import type { TestDetails } from './types.ts';
   *
   * // Defined, not invoked: writes the spec line and one ::error command per failing assertion.
   * function example(reporter: GithubReporter, config: Config, failed: TestDetails) {
   *   reporter.onTestEnd(config, failed);
   *   // "  ✖ adds (3ms)" … then "::error file=lib/math.ts,line=4,col=3,title=Math | adds::…"
   * }
   * ```
   */
  onTestEnd(config: Config, details: TestDetails): void {
    this.#spec.onTestEnd(config, details);
    if (details.status !== 'failed') return;

    // One annotation per failing assertion: each has its own location, and GitHub renders
    // them at their exact line. Emitted as one write so the block can't be split apart.
    const title = details.fullName.join(' | ');
    process.stdout.write(
      failedAssertions(details, config.state.group.sourceMapDecoder, config.projectRoot)
        .map((failure) => `${annotation(title, failure)}\n`)
        .join(''),
    );
  }

  /**
   * Delegates the summary + failure recap to the spec renderer.
   *
   * ```ts
   * import type { Config } from '../types.ts';
   *
   * // Defined, not invoked: prints the summary to stdout.
   * function example(reporter: GithubReporter, config: Config) {
   *   reporter.onRunEnd(config, { durationMs: 800 }); // "  5 passing (800ms)" …
   * }
   * ```
   */
  onRunEnd(config: Config, info: RunEndInfo): void {
    this.#spec.onRunEnd(config, info);
  }
}

/**
 * Builds one `::error file=…,line=…,col=…,title=…::message` workflow command.
 *
 * ```ts
 * annotation('Math | adds', {
 *   index: 1, message: 'bad sum', actual: 3, expected: 4, stack: null, at: 'lib/math.ts:4:3', source: null,
 * });
 * // '::error file=lib/math.ts,line=4,col=3,title=Math | adds::bad sum%0Aexpected: 4%0Aactual:   3'
 * ```
 */
export function annotation(title: string, failure: FailureInfo): string {
  const location = parseAt(failure.at);
  const properties = [
    ...(location
      ? [`file=${escapeProperty(location.file)}`, `line=${location.line}`, `col=${location.col}`]
      : []),
    `title=${escapeProperty(title)}`,
  ];

  const message = [
    failure.message ?? `Assertion #${failure.index} failed`,
    failure.expected !== undefined || failure.actual !== undefined
      ? `expected: ${format(failure.expected)}\nactual:   ${format(failure.actual)}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  return `::error ${properties.join(',')}::${escapeData(message)}`;
}

// GitHub workflow-command escaping. Without this a message containing a newline would end the
// command early and the rest would leak into the log as plain text.
// https://docs.github.com/actions/reference/workflow-commands-for-github-actions
function escapeData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

// Property values additionally escape `:` and `,` — the command's own delimiters.
function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function format(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  // A circular structure is the case this exists for; String(value) is what a reporter can
  // still print. Narrowed to the stringify so a bug in this function is not also swallowed.
  const json = Result.try(() => JSON.stringify(value));
  return json.ok ? (json.value ?? String(value)) : String(value);
}
