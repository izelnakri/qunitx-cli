import * as RunState from '../../lib/setup/run-state.ts';
import { processConsole } from '../../lib/console.ts';
import { updateCounter } from '../../lib/reporters/types.ts';
import type { Reporter, ReporterContext, TestDetails } from '../../lib/reporters/types.ts';
import { captureStdout } from './capture-stdout.ts';

/**
 * A {@link ReporterContext} for testing a reporter in isolation — no run, no browser, no `Config`.
 *
 * This is the shape a reporter actually receives, so a test constructs exactly what the contract
 * promises rather than casting a half-built `Config`. `counts` is a real, live `Counter`, which is
 * what lets {@link feed} update it between calls the way a run would.
 *
 * ```ts
 * makeContext().projectRoot; // '/proj'
 * makeContext({ projectRoot: '/elsewhere' }).projectRoot; // '/elsewhere'
 * ```
 */
export function makeContext(overrides: Partial<ReporterContext> = {}): ReporterContext {
  return {
    console: processConsole,
    counts: RunState.create().results.counter,
    projectRoot: '/proj',
    output: 'tmp',
    sourceMapDecoder: null,
    daemon: false,
    ...overrides,
  };
}

/**
 * Drives one `testEnd` through `reporter` and returns what it printed.
 *
 * The counter is updated first, exactly as `Reporter.testEnd` does, so a reporter that renders
 * running totals sees the same numbers it would during a real run.
 *
 * ```ts
 * import { DotReporter } from '../../lib/reporters/dot.ts';
 *
 * const passing = { status: 'passed', fullName: ['Mod', 't'], runtime: 1, assertions: [] } as const;
 * feed(new DotReporter(), makeContext(), passing); // '.'
 * ```
 */
export function feed(reporter: Reporter, context: ReporterContext, details: TestDetails): string {
  return captureStdout(() => {
    updateCounter(context.counts, details);
    reporter.onTestEnd?.(context, details);
  });
}
