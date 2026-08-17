// A runnable end-to-end example of the qunitx JS API: a quality gate that runs the suite,
// enforces a coverage floor, writes a JUnit report, and explains itself — the kind of script a
// CI job or an agent reaches for when it needs the *results*, not a terminal transcript.
//
// It runs the REAL lib/api/ against this repository's own fixtures, so what you read here is
// what the API actually does against a live browser.
//
// run:   node examples/js-api-quality-gate.ts
//        node examples/js-api-quality-gate.ts --verbose   (also stream the CLI's spec output)
// check: deno check examples/js-api-quality-gate.ts
//
// What it demonstrates, in the order the code does it:
//   1. `search()`  — what would run, without running it (no browser, milliseconds)
//   2. `test()`    — the suite, silent, with coverage and a JUnit document
//   3. `Failure`   — a run that could not happen, told apart from a run that failed
//   4. reporters   — a reporter of your own, alongside a built-in one
import process from 'node:process';
import { Failure, search, test, type Reporter, type RunResult } from '../lib/api/index.ts';

// This repo's own fixtures, so the example is runnable from a fresh clone with no setup.
const TARGET = 'test/fixtures/coverage/calculator-test.ts';
const COVERAGE_FLOOR = 50;
const verbose = process.argv.includes('--verbose');

// A reporter is any object with the handlers it cares about. This one tracks the slowest test,
// which is the sort of thing no built-in format will ever report for you.
const slowest: { name: string; ms: number } = { name: '(none)', ms: -1 };
const slowestReporter: Reporter = {
  onTestEnd(_config, details) {
    if (details.runtime <= slowest.ms) return;
    slowest.name = details.fullName.join(' > ');
    slowest.ms = details.runtime;
  },
};

console.log('1. What would run?\n');
const preview = await search({ inputs: [TARGET] });
for (const test of preview.matches) {
  console.log(`   ${test.fullName}  ${test.file.split('/').pop()}#${test.line}`);
}
console.log(`\n   ${preview.matches.length} of ${preview.total} tests, no browser involved.\n`);

console.log('2. Running them.\n');
const result = await test({
  inputs: [TARGET],
  output: 'tmp/js-api-example',
  coverage: true,
  junit: 'tmp/js-api-example/junit.xml',
  // Omit both entirely and nothing is printed at all; `--verbose` opts into the CLI's spec
  // output alongside the custom reporter, which runs either way. `reporter` takes one,
  // `reporters` takes several — passing both is an InvalidOption.
  ...(verbose ? { reporters: ['spec' as const, slowestReporter] } : { reporter: slowestReporter }),
});

report(result);

console.log('\n3. A run that cannot happen is not the same as a run that failed.\n');
// `.result()` settles to the bare `RunResult | RunFailure` union instead of throwing, so this
// branches rather than catching. `await test(…)` would throw the same failure.
const rejected = await test({ inputs: [TARGET], browser: 'netscape' as 'chromium' }).result();
if (Failure.is(rejected)) {
  // `format` already leads with the code, so printing `rejected.code` too would double it.
  console.log(`   ${Failure.format(rejected)}`);
} else {
  console.log('   unexpectedly ran');
}

const floorMet = (result.coverage?.percent ?? 0) >= COVERAGE_FLOOR;
console.log(
  `\nGate: ${result.ok && floorMet ? 'PASS' : 'FAIL'} ` +
    `(tests ${result.ok ? 'green' : 'red'}, coverage floor ${COVERAGE_FLOOR}% ${floorMet ? 'met' : 'missed'})`,
);
process.exitCode = result.ok && floorMet ? 0 : 1;

/** Prints the parts of a {@link RunResult} a gate actually reads. */
function report(outcome: RunResult): void {
  const { counts, coverage } = outcome;
  console.log(
    `   ${counts.passed}/${counts.total} passed in ${outcome.durationMs}ms` +
      `${counts.skipped ? `, ${counts.skipped} skipped` : ''}`,
  );
  for (const failure of outcome.failures) {
    const assertion = failure.assertions.find((one) => !one.passed);
    console.log(`   ✖ ${failure.fullName}${assertion?.message ? ` — ${assertion.message}` : ''}`);
  }
  if (coverage) {
    console.log(`   coverage ${coverage.percent}% (${coverage.files.length} files)`);
  }
  console.log(`   slowest: ${slowest.name} (${slowest.ms}ms)`);
  console.log(
    `   junit: ${outcome.junitXml ? `${outcome.junitXml.length} bytes` : 'not requested'}`,
  );
  // Every `# …` line the CLI would have printed, available as data instead. Printed first-line
  // only here because one of them is the whole coverage table, which was rendered above already.
  for (const notice of outcome.notices) {
    console.log(`   note[${notice.level}]: ${notice.message.split('\n')[0]}`);
  }
}
