import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

process.env['FORCE_COLOR'] = 0;

await fs.rm('./tmp', { recursive: true, force: true });
await fs.mkdir('./tmp/test', { recursive: true });
let [failingTestContent, passingTestContent] = await Promise.all([
  fs.readFile('./test/helpers/failing-tests.js'),
  fs.readFile('./test/helpers/passing-tests.js'),
]);

await Promise.all([
  fs.writeFile('./tmp/test/failing-tests.js', failingTestContent.toString()),
  fs.writeFile('./tmp/test/failing-tests.ts', failingTestContent.toString()),
  fs.writeFile('./tmp/test/passing-tests.js', passingTestContent.toString()),
  fs.writeFile('./tmp/test/passing-tests.ts', passingTestContent.toString()),
]);

// Start a cross-process Chrome concurrency semaphore server so all test workers
// share a single global slot count instead of each maintaining their own counter.
// The server writes its port to a file (passed as argv[2]) so no pipe is needed.
const SEMAPHORE_PORT_FILE = 'tmp/.semaphore-port';
spawn(process.execPath, ['test/semaphore-server.js', SEMAPHORE_PORT_FILE], {
  detached: true,
  stdio: 'ignore',
  cwd: process.cwd(),
}).unref();

// Poll until the server writes its port file (should be near-instant).
await new Promise((resolve) => {
  const poll = setInterval(async () => {
    try {
      const content = await fs.readFile(SEMAPHORE_PORT_FILE, 'utf8');
      if (content.trim() && !isNaN(parseInt(content, 10))) {
        clearInterval(poll);
        resolve();
      }
    } catch {
      // file not written yet, keep polling
    }
  }, 50);
});
