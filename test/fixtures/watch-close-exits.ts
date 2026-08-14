// Opens a watch session, closes it, and reports what is still holding the event loop open.
//
// Spawned by test/api/watch-test.ts rather than run in-process, because the thing under test is
// whether the PROCESS can exit — an in-process assertion cannot see that, and the suite's other
// handles would drown out the one that matters. If `close()` ever leaks again this script never
// reaches its own exit and the spawn times out, which is exactly the user-visible symptom.
//
// Usage: node test/fixtures/watch-close-exits.ts <test-file> <output-dir>
import { watch, silentConsole } from '../../lib/api/index.ts';

const [input, output] = process.argv.slice(2);

const session = await watch({ inputs: [input], output, console: silentConsole });
await session.close();

console.log(JSON.stringify(process.getActiveResourcesInfo()));
