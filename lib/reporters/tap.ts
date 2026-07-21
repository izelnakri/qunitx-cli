import * as Tap from '../tap/index.ts';
import { failedAssertions } from './failure.ts';
import type { Reporter, RunStartInfo, RunEndInfo, TestDetails } from './types.ts';
import type { Config } from '../types.ts';

/**
 * The default reporter: streams TAP version 13 to stdout. Stateless — every number it
 * prints comes from `config.state.results.counter`, which the dispatcher updates before `onTestEnd`.
 */
export class TapReporter implements Reporter {
  /** Emits the TAP version header, plus the run banner as a `#` comment. */
  onRunStart(config: Config, info: RunStartInfo): void {
    process.stdout.write('TAP version 13\n');
    // Watch mode emits the header per browser connection and has no file/group counts to
    // report at that point.
    if (info.fileCount === null) return;

    const daemon = config.state.daemon ? ' (daemon)' : '';
    if (info.fileCount === 0) {
      // No test files matched (e.g. --changed filtered everything out): emit a complete,
      // valid TAP document — header plus an empty plan — so parsers see a clean zero run.
      process.stdout.write(`# Running 0 test files${daemon}\n1..0\n`);
      return;
    }
    const files = `${info.fileCount} test file${info.fileCount === 1 ? '' : 's'}`;
    const groups = `${info.groupCount} group${info.groupCount === 1 ? '' : 's'}`;
    process.stdout.write(`# Running ${files} across ${groups}${daemon}\n`);
  }

  /** Emits the `ok` / `not ok` line, with a YAML block for each failing assertion. */
  onTestEnd(config: Config, details: TestDetails): void {
    // Only failed tests carry assertions — the injected runtime sends the trimmed
    // `{ status, fullName, runtime }` for every other status — so resolving failures for a
    // passing test is a call and an allocation that can never produce output. Guarding here
    // matches what every other reporter already does.
    const failures =
      details.status === 'failed'
        ? failedAssertions(details, config.state.group.sourceMapDecoder, config.projectRoot)
        : [];
    Tap.displayTestResult(config.state.results.counter.testCount, details, failures);
  }

  /** Emits the TAP plan line and the run summary. */
  onRunEnd(config: Config, info: RunEndInfo): void {
    Tap.displayFinalResult(config.state.results.counter, info.durationMs);
  }
}
