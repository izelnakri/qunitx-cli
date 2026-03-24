import Assert from '../../node_modules/qunitx/shims/shared/assert.js';

// Extracts stdout string and optional stderr from either a plain string or a
// result/error object ({ stdout, stderr }). This lets every assertion helper
// accept both forms transparently while surfacing stderr in failure diagnostics.
function extractOutput(result) {
  if (typeof result === 'string' || result == null) {
    return { stdout: result ?? '', stderr: null };
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr || null };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * assert.includes(result, needle, message?)
 * result may be a plain string (stdout) or a { stdout, stderr } object.
 * On failure: actual shows stdout (and stderr if present) so you see the full context.
 */
Assert.prototype.includes = function (result, needle, message) {
  const { stdout, stderr } = extractOutput(result);
  this.pushResult({
    result: stdout.includes(needle),
    actual: stderr ? { stdout, stderr } : stdout,
    expected: needle,
    message: message || `should contain: ${needle}`,
  });
};

/**
 * assert.outputContains(result, { contains: [...], notContains: [...] }, message?)
 * result may be a plain string (stdout) or a { stdout, stderr } object.
 * On failure: actual shows { missing, unexpectedlyFound, stdout, stderr? } so you see
 * exactly which strings failed, the full output context, and any CLI error output.
 */
Assert.prototype.outputContains = function (
  result,
  { contains = [], notContains = [] } = {},
  message,
) {
  const { stdout, stderr } = extractOutput(result);
  const matches = (p) => (p instanceof RegExp ? p.test(stdout) : stdout.includes(p));
  const missing = contains.filter((p) => !matches(p));
  const unexpectedlyFound = notContains.filter((p) => matches(p));
  const passed = missing.length === 0 && unexpectedlyFound.length === 0;

  this.pushResult({
    result: passed,
    actual: passed
      ? { missing: [], unexpectedlyFound: [] }
      : {
          missing: missing.map(String),
          unexpectedlyFound: unexpectedlyFound.map(String),
          stdout,
          ...(stderr ? { stderr } : {}),
        },
    expected: { missing: [], unexpectedlyFound: [] },
    message: message || 'stdout content check',
  });
};

/**
 * assert.hasDebugURL(result, message?)
 * Asserts that stdout contains the "# QUnitX running: http://localhost:<port>" debug line.
 */
Assert.prototype.hasDebugURL = function (result, message) {
  const { stdout, stderr } = extractOutput(result);
  this.pushResult({
    result: /# QUnitX running: http:\/\/localhost:\d+/.test(stdout),
    actual: stderr ? { stdout, stderr } : stdout,
    expected: '# QUnitX running: http://localhost:<port>',
    message: message || '--debug mode should print QUnitX running URL',
  });
};

/**
 * assert.matchesOutput(result, pattern, message)
 * Asserts that stdout matches a regex pattern.
 * On failure: actual shows stdout (and stderr if present).
 */
Assert.prototype.regex = function (result, pattern, message) {
  const { stdout, stderr } = extractOutput(result);
  this.pushResult({
    result: pattern.test(stdout),
    actual: stderr ? { stdout, stderr } : stdout,
    expected: String(pattern),
    message,
  });
};

/**
 * assert.exitCode(cmd, expectedCode, message?)
 * Asserts that the CLI exited with the given code.
 * cmd is the result/error object returned by shellFails (has .code, .stdout, .stderr).
 * On failure: shows the actual exit code plus the last 1000 chars of stdout so
 * you can see what the CLI printed when the exit code was unexpected.
 */
Assert.prototype.exitCode = function (cmd, expectedCode, message) {
  const passed = cmd?.code === expectedCode;
  const { stdout, stderr } = extractOutput(cmd);
  this.pushResult({
    result: passed,
    actual: passed
      ? { code: cmd?.code }
      : { code: cmd?.code, stdout: stdout.slice(-1000), ...(stderr ? { stderr } : {}) },
    expected: { code: expectedCode },
    message: message || `expected exit code ${expectedCode}`,
  });
};

const DEBUG_LOGS = [
  'resolving async test',
  'placeholder',
  'anotherObject',
  'calling deepEqual test case',
];
const PASSING_TEST_CASES = ['assert true works', 'async test finishes', 'deepEqual true works'];
// first test passes, remaining three fail — order matches failing-tests.js
const FAILING_TEST_CASES = [
  { status: 'ok', name: 'assert true works' },
  { status: 'not ok', name: 'async test finishes' },
  { status: 'not ok', name: 'runtime error output' },
  { status: 'not ok', name: 'deepEqual true works' },
];

export function assertPassingTestCasesFor(
  assert,
  result,
  options = { moduleName: '{{moduleName}}', debug: false },
) {
  const { moduleName, debug, testNo } = options;
  const mod = `${moduleName} Passing Tests`;

  const testLines =
    testNo != null
      ? PASSING_TEST_CASES.map(
          (name, i) =>
            new RegExp(
              `ok ${testNo + i} ${escapeRegex(mod)} \\| ${escapeRegex(name)} # \\(\\d+ ms\\)`,
            ),
        )
      : PASSING_TEST_CASES.map(
          (name) =>
            new RegExp(`ok \\d+ ${escapeRegex(mod)} \\| ${escapeRegex(name)} # \\(\\d+ ms\\)`),
        );

  assert.outputContains(
    result,
    {
      contains: [...testLines, ...(debug ? DEBUG_LOGS : [])],
    },
    `assertPassingTestCasesFor: ${mod}`,
  );
}

export function assertFailingTestCase(
  assert,
  result,
  options = { moduleName: '{{moduleName}}', debug: false },
) {
  const { moduleName, debug, testNo } = options;
  const mod = `${moduleName} Failing Tests`;

  const failLines =
    testNo != null
      ? FAILING_TEST_CASES.map(
          ({ status, name }, i) =>
            new RegExp(
              `${status} ${testNo + i} ${escapeRegex(mod)} \\| ${escapeRegex(name)} # \\(\\d+ ms\\)`,
            ),
        )
      : FAILING_TEST_CASES.filter(({ status }) => status === 'not ok').map(
          ({ name }) =>
            new RegExp(`not ok \\d+ ${escapeRegex(mod)} \\| ${escapeRegex(name)} # \\(\\d+ ms\\)`),
        );

  if (debug) {
    assert.outputContains(
      result,
      {
        contains: [
          'calling assert true test case',
          'resolving async test',
          'placeholder',
          'anotherObject',
        ],
      },
      `assertFailingTestCase debug: ${mod}`,
    );
  } else {
    assert.outputContains(
      result,
      {
        notContains: [
          'calling assert true test case',
          'resolving async test',
          'placeholder',
          'anotherObject',
        ],
        contains: [
          ...failLines,
          'Expected 4 assertions, but 3 were run',
          'actual: null',
          'expected: true',
          'Died on test #2',
          /name: 'Assertion #\d+'/,
          // Stack trace format differs by browser: Chrome uses 'at func (file:///...)',
          // WebKit/Firefox use '@http://host:port/:line:col'. Match either prefix.
          /stack:\s+'?(@|at )/,
        ],
      },
      `assertFailingTestCase: ${mod}`,
    );
  }
}

export function assertTAPResult(assert, result, options = { testCount: 0, failCount: 0 }) {
  const { testCount, failCount = 0, skipCount = 0 } = options;
  const { stdout, stderr } = extractOutput(result);
  const expectedPass = testCount - failCount;
  const tail = stdout.slice(-300);
  const actual = stderr ? { stdout: tail, stderr } : tail;

  if (failCount) {
    assert.pushResult({
      result: new RegExp(
        `# pass ${expectedPass}\n# skip ${skipCount}\n# fail (${failCount}|${failCount + 1})`,
      ).test(stdout),
      actual,
      expected: `# pass ${expectedPass}\n# skip ${skipCount}\n# fail ${failCount}`,
      message: `TAP summary should show pass=${expectedPass} skip=${skipCount} fail=${failCount}`,
    });
    return;
  }

  assert.pushResult({
    result: new RegExp(`# pass ${testCount}\n# skip ${skipCount}\n# fail 0`).test(stdout),
    actual,
    expected: `# pass ${testCount}\n# skip ${skipCount}\n# fail 0`,
    message: `TAP summary should show pass=${testCount} skip=${skipCount} fail=0`,
  });
}

export default {
  assertPassingTestCasesFor,
  assertFailingTestCase,
  assertTAPResult,
};
