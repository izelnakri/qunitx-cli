// Restarts a watch session, closes it, and proves the process is then free to exit.
//
// The sibling of watch-close-exits.ts, and here for the same reason: restart doubles every
// teardown path, so it is exactly where a handle gets left behind. Spawned rather than run
// in-process because the question is whether the PROCESS can exit.
//
// Usage: node test/fixtures/watch-restart-exits.ts <test-file> <output-dir>
import { watch, silentConsole } from '../../lib/api/index.ts';
import { reportLeakedHandles } from '../helpers/exit-report.ts';

const [input, output] = process.argv.slice(2);

const session = await watch({ inputs: [input], output, console: silentConsole });
await session.restart();
await session.close();

// Prints nothing at all if this process can end here, which is the whole assertion.
reportLeakedHandles();
