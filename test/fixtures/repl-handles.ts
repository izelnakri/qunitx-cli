// Opens a REPL through the JS API, uses it, closes it, and reports what is still holding the
// event loop open. Deliberately does NOT call process.exit: a leaked handle shows up twice — in
// the printed list, and as a process that never ends.
import { repl } from '../../lib/api/repl.ts';

const session = await repl({ output: 'tmp/repl-handles' });
await session.evaluate('1 + 1');
await session.evaluate("test('handles', (a) => a.true(true))");
await session.close();

// One turn of the loop, so anything closing asynchronously has settled before the census.
await new Promise((resolve) => setTimeout(resolve, 250));
process.stdout.write(`HANDLES ${JSON.stringify(process.getActiveResourcesInfo())}\n`);
