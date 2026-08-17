// Restarts a watch session, closes it, and reports what is still holding the event loop open.
//
// The sibling of watch-close-exits.ts, and here for the same reason: restart doubles every
// teardown path, so it is exactly where a handle gets left behind. Spawned rather than run
// in-process because the question is whether the PROCESS can exit.
//
// Usage: node test/fixtures/watch-restart-exits.ts <test-file> <output-dir>
import { watch, silentConsole } from '../../lib/api/index.ts';

const [input, output] = process.argv.slice(2);

const session = await watch({ inputs: [input], output, console: silentConsole });
await session.restart();
await session.close();

console.log(JSON.stringify(process.getActiveResourcesInfo()));
