// Runs one script through the JS API and reports what is still holding the event loop open.
//
// Spawned rather than run in-process, for the same reason as watch-close-exits.ts: the thing under
// test is whether the PROCESS can exit once the Task settles, and the suite's own handles would
// drown out the one that matters. A leaked browser or esbuild service here never lets this script
// reach its own exit, which is exactly the user-visible symptom.
//
// Usage: node test/fixtures/api-run-exits.ts <script-file>
import { run, silentConsole } from '../../lib/api/index.ts';
import { reportLeakedHandles } from '../helpers/exit-report.ts';

const [file] = process.argv.slice(2);

// Silenced so stdout is a protocol rather than a mixture: the result on the first line, and a
// second line ONLY if this process could not then exit. The script's own output would otherwise
// interleave with both.
const result = await run(file, { console: silentConsole });

console.log(JSON.stringify({ result }));
// Prints a second line only if this process CANNOT end here, which is the whole assertion.
reportLeakedHandles();
