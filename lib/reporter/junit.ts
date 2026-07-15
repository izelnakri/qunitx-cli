import fs from 'node:fs/promises';
import path from 'node:path';
import { failedAssertions } from './failure.ts';
import type { Reporter, RunEndInfo, TestDetails } from './types.ts';
import type { Config, JUnitCase } from '../types.ts';

/**
 * JUnit XML reporter — an *additive artifact* reporter, not a stdout format. Enabled with
 * `--junit[=<path>]`, it accumulates a `<testcase>` per `testEnd` and writes the document at
 * run end, while whichever `--reporter` is active keeps owning stdout. That split matters:
 * CI wants a readable log *and* a machine-readable file, and it's what `--coverage=lcov`
 * already does for coverage artifacts.
 *
 * Cases live on the instance (not on `config`), and the instance is shared across concurrent
 * groups, so one document covers the whole run. `onRunStart` resets it for watch reruns.
 */
export class JUnitReporter implements Reporter {
  #cases: JUnitCase[] = [];

  /** Drops cases from any previous run so watch reruns start clean. */
  onRunStart(): void {
    this.#cases = [];
  }

  /** Accumulates one `<testcase>`; the document is written once at run end. */
  onTestEnd(config: Config, details: TestDetails): void {
    this.#cases.push(toJUnitCase(config, details));
  }

  /** Serializes the accumulated cases and writes the XML document to disk. */
  async onRunEnd(config: Config, _info: RunEndInfo): Promise<void> {
    const outputPath = junitOutputPath(config);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, buildJUnitXML(this.#cases));
    process.stdout.write(
      `# wrote JUnit report to ${relativeToRoot(outputPath, config.projectRoot)}\n`,
    );
  }
}

/**
 * Resolves where the JUnit document is written: `--junit=<path>` (relative to the project
 * root) when given a string, else `<output>/junit.xml`.
 */
export function junitOutputPath(config: Config): string {
  return typeof config.junit === 'string'
    ? path.resolve(config.projectRoot, config.junit)
    : path.join(path.resolve(config.projectRoot, config.output), 'junit.xml');
}

/**
 * Converts one `testEnd` into a JUnit `<testcase>`. Failing assertions are flattened into a
 * `failureDetail` with stacks resolved back to original sources (same as the TAP `at:` field).
 */
export function toJUnitCase(config: Config, details: TestDetails): JUnitCase {
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

  const failures = failedAssertions(details, config._sourceMapDecoder, config.projectRoot);
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

/** Builds the full JUnit XML document string from a flat list of test cases. */
export function buildJUnitXML(cases: JUnitCase[]): string {
  // Map.groupBy keys by first appearance, so suites stay in the order their tests ran.
  const suites = Map.groupBy(cases, (testCase) => testCase.classname);

  return (
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<testsuites name="qunitx" tests="${cases.length}" failures="${countFailed(cases)}" ` +
        `skipped="${countSkipped(cases)}" time="${formatTime(totalTime(cases))}">`,
      ...[...suites].flatMap(([suiteName, suiteCases]) => buildSuite(suiteName, suiteCases)),
      '</testsuites>',
    ].join('\n') + '\n'
  );
}

/** Builds the `<testsuite>` block (with nested `<testcase>` elements) for one QUnit module. */
function buildSuite(suiteName: string, cases: JUnitCase[]): string[] {
  return [
    `  <testsuite name="${escapeAttr(suiteName)}" tests="${cases.length}" ` +
      `failures="${countFailed(cases)}" skipped="${countSkipped(cases)}" ` +
      `time="${formatTime(totalTime(cases))}">`,
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

function totalTime(cases: JUnitCase[]): number {
  return cases.reduce((sum, testCase) => sum + testCase.time, 0);
}

function countFailed(cases: JUnitCase[]): number {
  return cases.filter((testCase) => testCase.status === 'failed').length;
}

// `todo` has no JUnit equivalent and reports as skipped (see normalizeStatus), so both statuses
// count here. Shared by the <testsuites> and <testsuite> levels so the two can never disagree.
function countSkipped(cases: JUnitCase[]): number {
  return cases.filter((testCase) => testCase.status === 'skipped' || testCase.status === 'todo')
    .length;
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
