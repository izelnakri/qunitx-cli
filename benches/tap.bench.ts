/**
 * Benchmarks TAP output display throughput.
 * With large test suites these functions are called thousands of times, so
 * per-call cost compounds directly into total wall-clock output time.
 */
import TAPDisplayTestResult from "../lib/tap/display-test-result.ts";
import TAPDisplayFinalResult from "../lib/tap/display-final-result.ts";

// Suppress console output — we're measuring CPU cost, not I/O.
const noop = () => {};

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
  const counter = { testCount: 0, passCount: 0, skipCount: 0, failCount: 0, errorCount: 0 };
  const orig = console.log;
  console.log = noop;
  TAPDisplayTestResult(counter, PASSING_DETAILS);
  console.log = orig;
});

Deno.bench("tap: display single failing result", {
  group: "tap",
}, () => {
  const counter = { testCount: 0, passCount: 0, skipCount: 0, failCount: 0, errorCount: 0 };
  const orig = console.log;
  console.log = noop;
  TAPDisplayTestResult(counter, FAILING_DETAILS);
  console.log = orig;
});

Deno.bench("tap: display 100 mixed results", {
  group: "tap",
}, () => {
  const counter = { testCount: 0, passCount: 0, skipCount: 0, failCount: 0, errorCount: 0 };
  const orig = console.log;
  console.log = noop;
  for (let i = 0; i < 80; i++) TAPDisplayTestResult(counter, PASSING_DETAILS);
  for (let i = 0; i < 10; i++) TAPDisplayTestResult(counter, FAILING_DETAILS);
  for (let i = 0; i < 10; i++) TAPDisplayTestResult(counter, SKIPPED_DETAILS);
  console.log = orig;
});

Deno.bench("tap: display final result summary", {
  group: "tap",
}, () => {
  const orig = console.log;
  console.log = noop;
  TAPDisplayFinalResult(
    { testCount: 100, passCount: 80, skipCount: 10, failCount: 10, errorCount: 10 },
    1234,
  );
  console.log = orig;
});
