import './after-script-basic.ts';

// 50 ms is short enough to keep the test fast but long enough that an unawaited promise
// would race the CLI's process.exit — proving the runner actually awaits the after-script.
const AFTER_SCRIPT_DELAY_MS = 50;

export default async function (results: Record<string, number>): Promise<void> {
  const resultsInString = JSON.stringify(results, null, 2);
  // Real async work (a microtask hop is not enough — V8 may flush microtasks before exit).
  // Filesystem writes were the original choice but the shared `tmp/results.json` path
  // contended with concurrent tests' `--output=tmp/run-*` artifacts on Windows CI; a plain
  // timer demonstrates the exact same await semantics with zero shared state.
  await new Promise<void>((resolve) => setTimeout(resolve, AFTER_SCRIPT_DELAY_MS));

  console.log('After script result is written:');
  console.log(resultsInString);
}
