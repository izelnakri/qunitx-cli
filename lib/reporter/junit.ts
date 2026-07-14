import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveStack } from '../utils/source-map-decoder.ts';
import type { Config, JUnitCase } from '../types.ts';

/**
 * JUnit XML reporter. When `--reporter=junit` is active, `recordJUnitCase` is called from the
 * WebSocket `testEnd` handler (the same point TAP is streamed) for every test, and
 * `writeJUnitReport` serializes the accumulated cases into a `junit.xml` file at run end.
 * TAP continues to stream to stdout unchanged — the XML is an additional machine-readable
 * artifact for CI dashboards (GitHub Actions, GitLab, CircleCI, Jenkins, …).
 */

// Shape of the QUnit `testEnd` payload the WS handler forwards. Non-failed tests carry the
// trimmed `{ status, fullName, runtime }`; failed tests carry the full details incl. assertions.
interface TestDetails {
  status: string;
  fullName: string[];
  runtime: number;
  assertions?: Array<{
    passed: boolean;
    todo: boolean;
    message?: string;
    stack?: string;
  }>;
}

/**
 * Records one `testEnd` as a JUnit `<testcase>` on the run's shared collector. No-op unless a
 * collector is present (i.e. `--reporter=junit`). Failing assertions are flattened into a
 * `failureDetail` string with stacks resolved back to original sources via the bundle's source
 * map, matching the TAP `at:` behavior.
 */
export function recordJUnitCase(config: Config, details: TestDetails): void {
  const collector = config._junitCollector;
  if (!collector) return;

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

  if (status === 'failed') {
    const failed = (details.assertions ?? []).filter((a) => !a.passed && a.todo === false);
    if (failed.length > 0) {
      testCase.failureMessage = failed[0].message || 'Assertion failed';
      testCase.failureDetail = failed
        .map((assertion, index) => {
          const message = assertion.message || `Assertion #${index + 1} failed`;
          const stack = resolveAssertionStack(config, assertion.stack);
          return stack ? `${message}\n${stack}` : message;
        })
        .join('\n\n');
    } else {
      // Failed status with no failing assertion recorded (e.g. an uncaught error mid-test).
      testCase.failureMessage = 'Test failed';
    }
  }

  collector.push(testCase);
}

/**
 * Serializes the run's accumulated JUnit cases to `config.junitOutput` (default
 * `<output>/junit.xml`, resolved against `projectRoot`), grouping cases into one `<testsuite>`
 * per QUnit module. Prints the destination as a TAP `#` comment. No-op when no cases collected.
 */
export async function writeJUnitReport(config: Config): Promise<void> {
  const collector = config._junitCollector;
  if (!collector) return;

  const outputPath = config.junitOutput
    ? path.resolve(config.projectRoot, config.junitOutput)
    : path.join(path.resolve(config.projectRoot, config.output), 'junit.xml');

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buildJUnitXML(collector));
  process.stdout.write(
    `# wrote JUnit report to ${relativeToRoot(outputPath, config.projectRoot)}\n`,
  );
}

/** Builds the full JUnit XML document string from a flat list of test cases. */
export function buildJUnitXML(cases: JUnitCase[]): string {
  const suites = new Map<string, JUnitCase[]>();
  for (const testCase of cases) {
    const bucket = suites.get(testCase.classname);
    if (bucket) bucket.push(testCase);
    else suites.set(testCase.classname, [testCase]);
  }

  const totalTime = cases.reduce((sum, testCase) => sum + testCase.time, 0);
  const totalFailures = cases.filter((testCase) => testCase.status === 'failed').length;
  const totalSkipped = cases.filter(
    (testCase) => testCase.status === 'skipped' || testCase.status === 'todo',
  ).length;

  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push(
    `<testsuites name="qunitx" tests="${cases.length}" failures="${totalFailures}" ` +
      `skipped="${totalSkipped}" time="${formatTime(totalTime)}">`,
  );
  for (const [suiteName, suiteCases] of suites) {
    lines.push(...buildSuite(suiteName, suiteCases));
  }
  lines.push('</testsuites>');
  return lines.join('\n') + '\n';
}

export { writeJUnitReport as default };

/** Builds the `<testsuite>` block (with nested `<testcase>` elements) for one QUnit module. */
function buildSuite(suiteName: string, cases: JUnitCase[]): string[] {
  const suiteTime = cases.reduce((sum, testCase) => sum + testCase.time, 0);
  const failures = cases.filter((testCase) => testCase.status === 'failed').length;
  const skipped = cases.filter(
    (testCase) => testCase.status === 'skipped' || testCase.status === 'todo',
  ).length;

  const lines = [
    `  <testsuite name="${escapeAttr(suiteName)}" tests="${cases.length}" ` +
      `failures="${failures}" skipped="${skipped}" time="${formatTime(suiteTime)}">`,
  ];
  for (const testCase of cases) {
    const open =
      `    <testcase name="${escapeAttr(testCase.name)}" ` +
      `classname="${escapeAttr(testCase.classname)}" time="${formatTime(testCase.time)}"`;
    if (testCase.status === 'failed') {
      lines.push(`${open}>`);
      lines.push(
        `      <failure message="${escapeAttr(testCase.failureMessage ?? 'failed')}">` +
          `${escapeText(testCase.failureDetail ?? testCase.failureMessage ?? '')}</failure>`,
      );
      lines.push('    </testcase>');
    } else if (testCase.status === 'skipped' || testCase.status === 'todo') {
      lines.push(`${open}>`);
      lines.push(`      <skipped/>`);
      lines.push('    </testcase>');
    } else {
      lines.push(`${open}/>`);
    }
  }
  lines.push('  </testsuite>');
  return lines;
}

// QUnit's `skipped` maps to JUnit `<skipped/>`; `todo` (expected-fail work-in-progress) has no
// JUnit equivalent, so it is reported as skipped rather than polluting the failure count.
function normalizeStatus(status: string): JUnitCase['status'] {
  if (status === 'failed') return 'failed';
  if (status === 'skipped') return 'skipped';
  if (status === 'todo') return 'todo';
  return 'passed';
}

function resolveAssertionStack(config: Config, stack?: string): string | null {
  if (!stack) return null;
  const decoder = config._sourceMapDecoder;
  if (decoder && config.projectRoot) {
    return resolveStack(stack, decoder, config.projectRoot).resolvedStack.trim() || stack.trim();
  }
  return stack.trim();
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
