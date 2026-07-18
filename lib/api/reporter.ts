import { attributeFailureFile } from '../utils/failure-cache.ts';
import { resolveStack } from '../utils/source-map-decoder.ts';
import type {
  Reporter,
  RunStartInfo,
  RunEndInfo,
  TestAssertion,
  TestDetails,
} from '../reporter/types.ts';
import type { Config } from '../types.ts';
import type { Assertion, TestResult, TestStatus } from './types.ts';

/** Callbacks the API layer attaches to observe a run as it happens. */
export interface ApiReporterHandlers {
  /** Called once when the run begins. */
  onRunStart?: (info: RunStartInfo) => void;
  /** Called as each test finishes, with the translated public result. */
  onTestEnd?: (test: TestResult) => void;
  /** Called once when the run completes. */
  onRunEnd?: (info: RunEndInfo) => void;
}

/**
 * Bridges the internal reporter contract onto the public event stream. This is the single
 * translation point between QUnit's `testEnd` payload and {@link TestResult}, which is what
 * lets the internal shape keep changing without breaking API consumers.
 *
 * Attached as an additional reporter, so it observes the exact same events (and the same
 * counter state) as whichever stdout reporter the caller selected.
 */
export class ApiReporter implements Reporter {
  /** Every test result collected in the current run, in completion order. */
  readonly tests: TestResult[] = [];
  // Declared as a field rather than a constructor parameter property: the project runs
  // TypeScript through Node's strip-only loader, which only erases types.
  /** The API-layer callbacks this reporter forwards to. */
  readonly handlers: ApiReporterHandlers;

  /** Constructs a reporter that forwards translated events to `handlers`. */
  constructor(handlers: ApiReporterHandlers) {
    this.handlers = handlers;
  }

  /** Resets the collected results and announces the run. */
  onRunStart(_config: Config, info: RunStartInfo): void {
    // Watch mode reuses one session across reruns; each run reports its own test list.
    this.tests.length = 0;
    this.handlers.onRunStart?.(info);
  }

  /** Translates one `testEnd` into a {@link TestResult}, records it, and forwards it. */
  onTestEnd(config: Config, details: TestDetails): void {
    const test = toTestResult(config, details);
    this.tests.push(test);
    this.handlers.onTestEnd?.(test);
  }

  /** Announces that the run finished. */
  onRunEnd(_config: Config, info: RunEndInfo): void {
    this.handlers.onRunEnd?.(info);
  }
}

/** Translates one internal `testEnd` payload into the public {@link TestResult} shape. */
function toTestResult(config: Config, details: TestDetails): TestResult {
  const module = details.fullName.slice(0, -1);
  const name = details.fullName.at(-1) ?? '';
  const assertions = (details.assertions ?? []).map((assertion) => toAssertion(config, assertion));

  return {
    name,
    module,
    fullName: [...module, name].join(' > '),
    status: details.status as TestStatus,
    duration: details.runtime,
    // Only failures carry a stack to attribute from; passing tests report no assertions,
    // so their originating file is not knowable from the payload alone.
    file: attributeFailureFile(details.assertions, config._sourceMapDecoder, config.projectRoot),
    assertions,
  };
}

/**
 * Resolves an assertion's bundle-relative stack back to original sources, so a consumer never
 * sees frames pointing at `tmp/tests.js`.
 */
function toAssertion(config: Config, assertion: TestAssertion): Assertion {
  const decoder = config._sourceMapDecoder;
  const stack =
    assertion.stack && decoder
      ? resolveStack(assertion.stack, decoder, config.projectRoot).resolvedStack
      : assertion.stack;

  return {
    passed: assertion.passed,
    todo: assertion.todo,
    message: assertion.message,
    actual: assertion.actual,
    expected: assertion.expected,
    stack,
  };
}
