import fs from 'node:fs/promises';
import path from 'node:path';
import { failedAssertions } from './failure.ts';
import type { Reporter, RunEndInfo, TestDetails, ReporterContext } from './types.ts';
import type { JUnitCase } from '../types.ts';

/**
 * JUnit XML reporter — an *additive artifact* reporter, not a stdout format. Enabled with
 * `--junit[=<path>]`, it accumulates a `<testcase>` per `testEnd` and writes the document at
 * run end, while whichever `--reporter` is active keeps owning stdout. That split matters:
 * CI wants a readable log *and* a machine-readable file, and it's what `--coverage=lcov`
 * already does for coverage artifacts.
 *
 * Cases live on the instance (not on `context`), and the instance is shared across concurrent
 * groups, so one document covers the whole run. `onRunStart` resets it for watch reruns.
 *
 * ```ts
 * import type { ReporterContext } from './types.ts';
 *
 * import type { TestDetails } from './types.ts';
 *
 * // Defined, not invoked: onRunEnd writes junit.xml to disk.
 * async function example(context: ReporterContext, details: TestDetails) {
 *   const reporter = new JUnitReporter();
 *   reporter.onRunStart();
 *   reporter.onTestEnd(context, details); // one <testcase> recorded
 *   await reporter.onRunEnd(context, { durationMs: 40 }); // document written to outputPath(context)
 * }
 * ```
 */
export class JUnitReporter implements Reporter {
  #cases: JUnitCase[] = [];

  /**
   * Drops cases from any previous run so watch reruns start clean.
   *
   * ```ts
   * const reporter = new JUnitReporter();
   * reporter.onRunStart(); // cases recorded by a previous watch-mode run are gone
   * ```
   */
  onRunStart(): void {
    this.#cases = [];
  }

  /**
   * Accumulates one `<testcase>`; the document is written once at run end.
   *
   * ```ts
   * import type { ReporterContext } from './types.ts';
   *
   * const reporter = new JUnitReporter();
   * reporter.onTestEnd({} as ReporterContext, { status: 'passed', fullName: ['Math', 'adds'], runtime: 2 });
   * // recorded as <testcase name="adds" classname="Math"/> (context is only read for failures)
   * ```
   */
  onTestEnd(context: ReporterContext, details: TestDetails): void {
    this.#cases.push(toCase(context, details));
  }

  /**
   * Serializes the accumulated cases and writes the XML document to disk.
   *
   * ```ts
   * import type { ReporterContext } from './types.ts';
   *
   * // Defined, not invoked: writes the XML document to disk.
   * async function example(reporter: JUnitReporter, context: ReporterContext) {
   *   await reporter.onRunEnd(context, { durationMs: 40 });
   *   // "# wrote JUnit report to tmp/junit.xml" on stdout
   * }
   * ```
   */
  /**
   * The XML document as it stands. `onRunEnd` writes exactly this to disk; the JS API reads it
   * back so a caller can ship the report somewhere other than the filesystem.
   *
   * ```ts
   * const reporter = new JUnitReporter();
   * reporter.xml().startsWith('<?xml'); // true — an empty but well-formed document
   * ```
   */
  xml(): string {
    return buildXML(this.#cases);
  }

  /**
   * Serializes the accumulated cases and writes the XML document to disk.
   *
   * ```ts
   * import type { ReporterContext } from './types.ts';
   *
   * // Defined, not invoked: writes the XML document to disk.
   * async function example(reporter: JUnitReporter, context: ReporterContext) {
   *   await reporter.onRunEnd(context, { durationMs: 40 });
   *   // "# wrote JUnit report to tmp/junit.xml" on the run's output
   * }
   * ```
   */
  async onRunEnd(context: ReporterContext, _info: RunEndInfo): Promise<void> {
    const file = outputPath(context);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, this.xml());
    context.console.log(`# wrote JUnit report to ${relativeToRoot(file, context.projectRoot)}\n`);
  }
}

/**
 * Resolves where the JUnit document is written: `--junit=<path>` (relative to the project
 * root) when given a string, else `<output>/junit.xml`.
 *
 * ```ts
 * import type { ReporterContext } from './types.ts';
 *
 * const context = { projectRoot: '/repo', output: 'tmp', junit: true } as ReporterContext;
 * outputPath(context); // '/repo/tmp/junit.xml'
 * outputPath({ ...context, junit: 'reports/junit.xml' }); // '/repo/reports/junit.xml'
 * ```
 */
export function outputPath(context: ReporterContext): string {
  return typeof context.junit === 'string'
    ? path.resolve(context.projectRoot, context.junit)
    : path.join(path.resolve(context.projectRoot, context.output), 'junit.xml');
}

/**
 * Converts one `testEnd` into a JUnit `<testcase>`. Failing assertions are flattened into a
 * `failureDetail` with stacks resolved back to original sources (same as the TAP `at:` field).
 *
 * ```ts
 * import type { ReporterContext } from './types.ts';
 *
 * toCase({} as ReporterContext, { status: 'passed', fullName: ['Math', 'adds'], runtime: 1500 });
 * // { classname: 'Math', name: 'adds', time: 1.5, status: 'passed' } — context is only
 * // read for failed tests (the group's source-map decoder resolves their stacks)
 * ```
 */
export function toCase(context: ReporterContext, details: TestDetails): JUnitCase {
  const fullName = details.fullName;
  const name = fullName[fullName.length - 1] ?? fullName.join(' | ');
  const classname = fullName.slice(0, -1).join(' > ') || '(root)';
  const status = normalizeStatus(details.status);
  const testCase: JUnitCase = {
    classname,
    name,
    time: (details.runtime ?? 0) / 1000,
    status,
  };

  if (status !== 'failed') return testCase;

  const failures = failedAssertions(details, context.sourceMapDecoder, context.projectRoot);
  if (failures.length === 0) {
    // Failed status with no failing assertion recorded (e.g. an uncaught error mid-test).
    testCase.failureMessage = 'Test failed';
    return testCase;
  }
  testCase.failureMessage = failures[0].message || 'Assertion failed';
  testCase.failureDetail = failures
    .map((failure) => {
      const message = failure.message || `Assertion #${failure.index} failed`;
      return failure.stack ? `${message}\n${failure.stack}` : message;
    })
    .join('\n\n');
  return testCase;
}

/**
 * Builds the full JUnit XML document string from a flat list of test cases.
 *
 * ```ts
 * const xml = buildXML([{ classname: 'Math', name: 'adds', time: 0.002, status: 'passed' }]);
 * xml.includes('<testsuite name="Math" tests="1" failures="0" skipped="0" time="0.002">'); // true
 * xml.includes('<testcase name="adds" classname="Math" time="0.002"/>'); // true — self-closing
 * ```
 */
export function buildXML(cases: JUnitCase[]): string {
  // Map.groupBy keys by first appearance, so suites stay in the order their tests ran.
  const suites = Map.groupBy(cases, (testCase) => testCase.classname);
  const suite = summarize(cases);

  return (
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<testsuites name="qunitx" tests="${cases.length}" failures="${suite.failed}" ` +
        `skipped="${suite.skipped}" time="${formatTime(suite.time)}">`,
      ...[...suites].flatMap(([suiteName, suiteCases]) => buildSuite(suiteName, suiteCases)),
      '</testsuites>',
    ].join('\n') + '\n'
  );
}

/** Builds the `<testsuite>` block (with nested `<testcase>` elements) for one QUnit module. */
function buildSuite(suiteName: string, cases: JUnitCase[]): string[] {
  const suite = summarize(cases);

  return [
    `  <testsuite name="${escapeAttr(suiteName)}" tests="${cases.length}" ` +
      `failures="${suite.failed}" skipped="${suite.skipped}" ` +
      `time="${formatTime(suite.time)}">`,
    ...cases.flatMap(buildCase),
    '  </testsuite>',
  ];
}

/** One `<testcase>`: self-closing when it passed, wrapping `<failure>`/`<skipped/>` otherwise. */
function buildCase(testCase: JUnitCase): string[] {
  const open =
    `    <testcase name="${escapeAttr(testCase.name)}" ` +
    `classname="${escapeAttr(testCase.classname)}" time="${formatTime(testCase.time)}"`;

  if (testCase.status === 'failed') {
    return [
      `${open}>`,
      `      <failure message="${escapeAttr(testCase.failureMessage ?? 'failed')}">` +
        `${escapeText(testCase.failureDetail ?? testCase.failureMessage ?? '')}</failure>`,
      '    </testcase>',
    ];
  } else if (testCase.status === 'skipped' || testCase.status === 'todo') {
    return [`${open}>`, `      <skipped/>`, '    </testcase>'];
  }
  return [`${open}/>`];
}

/**
 * The three numbers a `<testsuite(s)>` element needs, in one pass.
 *
 * Together rather than as three functions, because both levels need all three: three helpers
 * meant six traversals of the same array to fill two elements, and it was the shared helper —
 * not the shared array — that kept the levels agreeing. One summary makes that structural.
 *
 * `todo` has no JUnit equivalent and reports as skipped (see normalizeStatus), so both statuses
 * count as skipped here.
 */
function summarize(cases: JUnitCase[]): { failed: number; skipped: number; time: number } {
  return cases.reduce(
    (totals, testCase) => {
      if (testCase.status === 'failed') totals.failed++;
      else if (testCase.status === 'skipped' || testCase.status === 'todo') totals.skipped++;
      totals.time += testCase.time;

      return totals;
    },
    { failed: 0, skipped: 0, time: 0 },
  );
}

// QUnit's `skipped` maps to JUnit `<skipped/>`; `todo` (expected-fail work-in-progress) has no
// JUnit equivalent, so it is reported as skipped rather than polluting the failure count.
const JUNIT_STATUSES: Record<string, JUnitCase['status']> = {
  failed: 'failed',
  skipped: 'skipped',
  todo: 'todo',
};

function normalizeStatus(status: string): JUnitCase['status'] {
  return JUNIT_STATUSES[status] ?? 'passed';
}

function relativeToRoot(absolutePath: string, projectRoot: string): string {
  const prefix = `${projectRoot}/`;
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
}

/** JUnit `time` is seconds with millisecond precision. */
function formatTime(seconds: number): string {
  return seconds.toFixed(3);
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

function escapeText(value: string): string {
  return (
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Strip control chars XML 1.0 forbids (except tab/newline/carriage-return) so stacks
      // with stray escape sequences don't produce an unparseable document.
      // deno-lint-ignore no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
  );
}
