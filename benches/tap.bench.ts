/**
 * Benchmarks TAP output display throughput.
 * With large test suites these functions are called thousands of times, so
 * per-call cost compounds directly into total wall-clock output time.
 */
import TAPDisplayTestResult from "../lib/tap/display-test-result.ts";
import TAPDisplayFinalResult from "../lib/tap/display-final-result.ts";
import { updateCounter } from "../lib/reporter/types.ts";
import { failedAssertions } from "../lib/reporter/failure.ts";

// Mirrors what a real run does per test (reportTestEnd -> TapReporter.onTestEnd): count it,
// resolve any failures, then render. TAPDisplayTestResult is a pure formatter now, so calling
// it alone would measure less work than the runner actually performs.
const displayTestResult = (
  counter: Parameters<typeof updateCounter>[0],
  details: Parameters<typeof failedAssertions>[0],
) => {
  updateCounter(counter, details);
  TAPDisplayTestResult(counter.testCount, details, failedAssertions(details));
};

// Suppress all output once at module level — patching inside each
// iteration deoptimises V8's JIT-compiled inline cache, inflating
// measurements and creating GC pressure for the entire process.
// Must suppress process.stdout.write too: TAP functions use it directly
// (not console.log) after the a63db40 overhaul.
console.log = () => {};
process.stdout.write = () => true;

const PASSING_DETAILS = {
  status: "passed",
  fullName: ["My Module", "does the thing correctly"],
  runtime: 42,
  assertions: [],
};

const FAILING_DETAILS = {
  status: "failed",
  fullName: ["My Module", "fails as expected"],
  runtime: 17,
  assertions: [
    {
      passed: false,
      todo: false,
      actual: "foo",
      expected: "bar",
      message: "expected values to be equal",
      stack: "Error\n    at (file:///src/my-test.js:10:5)",
    },
  ],
};

const SKIPPED_DETAILS = {
  status: "skipped",
  fullName: ["My Module", "skipped test"],
  runtime: 0,
  assertions: [],
};

Deno.bench("tap: display single passing result", {
  group: "tap",
  baseline: true,
}, () => {
  const counter = { testCount: 0, passCount: 0, skipCount: 0, todoCount: 0, failCount: 0, errorCount: 0 };
  displayTestResult(counter, PASSING_DETAILS);
});

Deno.bench("tap: display single failing result", {
  group: "tap",
}, () => {
  const counter = { testCount: 0, passCount: 0, skipCount: 0, todoCount: 0, failCount: 0, errorCount: 0 };
  displayTestResult(counter, FAILING_DETAILS);
});

Deno.bench("tap: display 100 mixed results", {
  group: "tap",
}, () => {
  const counter = { testCount: 0, passCount: 0, skipCount: 0, todoCount: 0, failCount: 0, errorCount: 0 };
  for (let i = 0; i < 80; i++) displayTestResult(counter, PASSING_DETAILS);
  for (let i = 0; i < 10; i++) displayTestResult(counter, FAILING_DETAILS);
  for (let i = 0; i < 10; i++) displayTestResult(counter, SKIPPED_DETAILS);
});

Deno.bench("tap: display final result summary", {
  group: "tap",
}, () => {
  TAPDisplayFinalResult(
    { testCount: 100, passCount: 80, skipCount: 5, todoCount: 5, failCount: 10, errorCount: 10 },
    1234,
  );
});
