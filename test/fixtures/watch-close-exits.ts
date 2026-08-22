// Opens a watch session, closes it, and proves the process is then free to exit.
//
// Spawned by test/api/watch-test.ts rather than run in-process, because the thing under test is
// whether the PROCESS can exit — an in-process assertion cannot see that, and the suite's other
// handles would drown out the one that matters.
//
// Usage: node test/fixtures/watch-close-exits.ts <test-file> <output-dir>
import { watch, silentConsole } from '../../lib/api/index.ts';
import { reportLeakedHandles } from '../helpers/exit-report.ts';

const [input, output] = process.argv.slice(2);

const session = await watch({ inputs: [input], output, console: silentConsole });
await session.close();

// Prints nothing at all if this process can end here, which is the whole assertion.
reportLeakedHandles();
