import { SpecReporter } from './spec.ts';
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
 */
export class GithubReporter implements Reporter {
  #spec = new SpecReporter();

  /** Delegates the run banner to the spec renderer. */
  onRunStart(config: Config, info: RunStartInfo): void {
    this.#spec.onRunStart(config, info);
  }

  /** Renders the spec line, then annotates each failing assertion for the PR diff. */
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

  /** Delegates the summary + failure recap to the spec renderer. */
  onRunEnd(config: Config, info: RunEndInfo): void {
    this.#spec.onRunEnd(config, info);
  }
}

/** Builds one `::error file=…,line=…,col=…,title=…::message` workflow command. */
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
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
