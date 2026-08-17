// Runs one script through the JS API and reports what is still holding the event loop open.
//
// Spawned rather than run in-process, for the same reason as watch-close-exits.ts: the thing under
// test is whether the PROCESS can exit once the Task settles, and the suite's own handles would
// drown out the one that matters. A leaked browser or esbuild service here never lets this script
// reach its own exit, which is exactly the user-visible symptom.
//
// Usage: node test/fixtures/api-run-exits.ts <script-file>
import { run } from '../../lib/api/index.ts';

const [file] = process.argv.slice(2);

const result = await run(file);

console.log(JSON.stringify({ result, handles: process.getActiveResourcesInfo() }));
