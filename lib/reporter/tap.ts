import { TAPDisplayTestResult } from '../tap/display-test-result.ts';
import { TAPDisplayFinalResult } from '../tap/display-final-result.ts';
import { failedAssertions } from './failure.ts';
import type { Reporter, RunStartInfo, RunEndInfo, TestDetails } from './types.ts';
import type { Config } from '../types.ts';

/**
 * The default reporter: streams TAP version 13 to stdout. Stateless — every number it
 * prints comes from `config.COUNTER`, which the dispatcher updates before `onTestEnd`.
 */
export class TapReporter implements Reporter {
  /** Emits the TAP version header, plus the run banner as a `#` comment. */
  onRunStart(config: Config, info: RunStartInfo): void {
    process.stdout.write('TAP version 13\n');
    // Watch mode emits the header per browser connection and has no file/group counts to
    // report at that point.
    if (info.fileCount === null) return;

    const daemon = config._daemonMode ? ' (daemon)' : '';
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
    TAPDisplayTestResult(
      config.COUNTER.testCount,
      details,
      failedAssertions(details, config._sourceMapDecoder, config.projectRoot),
    );
  }

  /** Emits the TAP plan line and the run summary. */
  onRunEnd(config: Config, info: RunEndInfo): void {
    TAPDisplayFinalResult(config.COUNTER, info.durationMs);
  }
}
