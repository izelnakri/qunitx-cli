import Assert from 'qunitx/assert';

/**
 * assert.includes(result, needle, message?)
 * result may be a plain string (stdout) or a CapturedResult/CapturedError object.
 * On failure: actual shows stdout, stderr, exit code, signal, child runtime, and the
 * arrival timestamp of the last stdout/stderr chunks — enough context to diagnose Windows
 * stdout-truncation flakes from the failure message alone.
 */
Assert.prototype.includes = function (result, needle, message) {
  const ctx = normalize(result);
  const passed = ctx.stdout.includes(needle);
  this.pushResult({
    result: passed,
    actual: passed ? ctx.stdout : ctx,
    expected: needle,
    message: message || `should contain: ${needle}`,
  });
};

/**
 * assert.notIncludes(result, needle, message?)
 * result may be a plain string (stdout) or a CapturedResult/CapturedError object.
 * On failure: actual carries the same diagnostic surface as `assert.includes`.
 */
Assert.prototype.notIncludes = function (result, needle, message) {
  const ctx = normalize(result);
  const passed = !ctx.stdout.includes(needle);
  this.pushResult({
    result: passed,
    actual: passed ? ctx.stdout : ctx,
    expected: `should NOT contain: ${needle}`,
    message: message || `should not contain: ${needle}`,
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
  const ctx = normalize(result);
  const matches = (pattern) =>
    pattern instanceof RegExp ? pattern.test(ctx.stdout) : ctx.stdout.includes(pattern);
  const missing = contains.filter((pattern) => !matches(pattern));
  const unexpectedlyFound = notContains.filter((pattern) => matches(pattern));
  const passed = missing.length === 0 && unexpectedlyFound.length === 0;

  this.pushResult({
    result: passed,
    actual: passed
      ? { missing: [], unexpectedlyFound: [] }
      : { ...ctx, missing: missing.map(String), unexpectedlyFound: unexpectedlyFound.map(String) },
    expected: { missing: [], unexpectedlyFound: [] },
    message: message || 'stdout content check',
  });
};

/**
 * assert.hasDebugURL(result, message?)
 * Asserts that stdout contains the "# QUnitX running: http://localhost:<port>" debug line.
 */
Assert.prototype.hasDebugURL = function (result, message) {
  const ctx = normalize(result);
  const passed = /# QUnitX running: http:\/\/localhost:\d+/.test(ctx.stdout);
  this.pushResult({
    result: passed,
    actual: passed ? ctx.stdout : ctx,
    expected: '# QUnitX running: http://localhost:<port>',
    message: message || '--debug mode should print QUnitX running URL',
  });
};

/**
 * assert.regex(result, pattern, message)
 * Asserts that stdout matches a regex pattern.
 * On failure: actual carries the diagnostic surface (stdout, stderr, exit code, signal,
 * runtime, last-chunk timestamps).
 */
Assert.prototype.regex = function (result, pattern, message) {
  const ctx = normalize(result);
  const passed = pattern.test(ctx.stdout);
  this.pushResult({
    result: passed,
    actual: passed ? ctx.stdout : ctx,
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
  const ctx = normalize(cmd);
  this.pushResult({
    result: passed,
    actual: passed ? { code: cmd?.code } : { ...ctx, stdout: ctx.stdout.slice(-1000) },
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

/**
 * assert.passingTestCaseFor(output, { moduleName, debug?, testNo? })
 * Asserts that output contains TAP lines for all passing test cases in the given module.
 */
Assert.prototype.passingTestCaseFor = function (
  output,
  { moduleName = '{{moduleName}}', debug = false, testNo } = {},
) {
  const mod = `${moduleName} Passing Tests`;
  const escaped = escapeRegex(mod);

  const testLines =
    testNo != null
      ? PASSING_TEST_CASES.map(
          (name, i) =>
            new RegExp(`ok ${testNo + i} ${escaped} \\| ${escapeRegex(name)} # \\(\\d+ ms\\)`),
        )
      : PASSING_TEST_CASES.map(
          (name) => new RegExp(`ok \\d+ ${escaped} \\| ${escapeRegex(name)} # \\(\\d+ ms\\)`),
        );

  this.outputContains(
    output,
    { contains: [...testLines, ...(debug ? DEBUG_LOGS : [])] },
    `passingTestCaseFor: ${mod}`,
  );
};

/**
 * assert.passingTestCasesFor(output, [{ moduleName, debug?, testNo? }, ...])
 * Asserts passing test cases for each module in the array. debug defaults to false per entry.
 */
Assert.prototype.passingTestCasesFor = function (output, arrayOfOptions) {
  for (const options of arrayOfOptions) {
    this.passingTestCaseFor(output, options);
  }
};

/**
 * assert.failingTestCaseFor(output, { moduleName, debug?, testNo? })
 * Asserts that output contains TAP lines for the failing test cases in the given module.
 */
Assert.prototype.failingTestCaseFor = function (
  output,
  { moduleName = '{{moduleName}}', debug = false, testNo } = {},
) {
  const mod = `${moduleName} Failing Tests`;
  const escaped = escapeRegex(mod);

  if (debug) {
    this.outputContains(
      output,
      {
        contains: [
          'calling assert true test case',
          'resolving async test',
          'placeholder',
          'anotherObject',
        ],
      },
      `failingTestCaseFor debug: ${mod}`,
    );
    return;
  }

  const failLines =
    testNo != null
      ? FAILING_TEST_CASES.map(
          ({ status, name }, i) =>
            new RegExp(
              `${status} ${testNo + i} ${escaped} \\| ${escapeRegex(name)} # \\(\\d+ ms\\)`,
            ),
        )
      : FAILING_TEST_CASES.filter(({ status }) => status === 'not ok').map(
          ({ name }) =>
            new RegExp(`not ok \\d+ ${escaped} \\| ${escapeRegex(name)} # \\(\\d+ ms\\)`),
        );

  this.outputContains(
    output,
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
    `failingTestCaseFor: ${mod}`,
  );
};

/**
 * assert.failingTestCasesFor(output, [{ moduleName, debug?, testNo? }, ...])
 * Asserts failing test cases for each module in the array. debug defaults to false per entry.
 */
Assert.prototype.failingTestCasesFor = function (output, arrayOfOptions) {
  for (const options of arrayOfOptions) {
    this.failingTestCaseFor(output, options);
  }
};

/**
 * assert.tapResult(output, { testCount, failCount?, skipCount?, todoCount? })
 * Asserts that output's TAP summary line matches the expected counts.
 */
Assert.prototype.tapResult = function (output, options = { testCount: 0, failCount: 0 }) {
  const { testCount, failCount = 0, skipCount = 0, todoCount = 0 } = options;
  const ctx = normalize(output);
  const expectedPass = testCount - failCount;
  // Tail rather than full stdout: TAP summaries are large and test output tails are where
  // the # pass/# fail/# duration lines live; everything earlier is noise for this assert.
  const actual = { ...ctx, stdout: ctx.stdout.slice(-300) };

  if (failCount) {
    this.pushResult({
      result: new RegExp(
        `# pass ${expectedPass}\n# skip ${skipCount}\n# todo ${todoCount}\n# fail (${failCount}|${failCount + 1})`,
      ).test(ctx.stdout),
      actual,
      expected: `# pass ${expectedPass}\n# skip ${skipCount}\n# todo ${todoCount}\n# fail ${failCount}`,
      message: `TAP summary should show pass=${expectedPass} skip=${skipCount} todo=${todoCount} fail=${failCount}`,
    });
    return;
  }

  this.pushResult({
    result: new RegExp(
      `# pass ${testCount}\n# skip ${skipCount}\n# todo ${todoCount}\n# fail 0`,
    ).test(ctx.stdout),
    actual,
    expected: `# pass ${testCount}\n# skip ${skipCount}\n# todo ${todoCount}\n# fail 0`,
    message: `TAP summary should show pass=${testCount} skip=${skipCount} todo=${todoCount} fail=0`,
  });
};

// Extracts the diagnostic surface from either a plain stdout string or a CapturedResult /
// CapturedError object: stdout, stderr, exit code, terminating signal, child runtime, and the
// arrival timestamp + size of the last stdout/stderr chunks. The chunk timestamps in
// particular turn an opaque "exit 0 with truncated stdout" Windows flake into a self-explaining
// failure: a last-stdout-chunk at 50 ms followed by exit at 9 000 ms means "child wrote then
// hung silently for 8.95 s," which is impossible to spot from stdout alone.
function normalize(result) {
  if (typeof result === 'string' || result == null) {
    return { stdout: result ?? '' };
  }
  // Watch-mode tests assert on a slice of session.stdout (e.g. "the last run's output")
  // for correctness, but on failure the full buffer is what shows the rerun sequence
  // and watcher event order. Pass `{ stdout: slice, fullStdout: session.stdout }` so
  // the assertion checks the slice but surfaces the full buffer on failure.
  if (typeof result === 'object' && 'stdout' in result && 'fullStdout' in result) {
    return { stdout: String(result.stdout ?? ''), fullStdout: String(result.fullStdout ?? '') };
  }
  const lastStdout = result.stdoutChunks?.at?.(-1);
  const lastStderr = result.stderrChunks?.at?.(-1);
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr || undefined,
    code: result.code,
    signal: result.signal || undefined,
    durationMs: typeof result.duration === 'number' ? Math.round(result.duration) : undefined,
    lastStdoutAtMs: lastStdout ? Math.round(lastStdout.time) : undefined,
    lastStderrAtMs: lastStderr ? Math.round(lastStderr.time) : undefined,
  };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
