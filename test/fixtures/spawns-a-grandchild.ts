// Stands in for a run that launched a browser: a child of a child, which a plain `child.kill()`
// on the parent does not touch.
//
// Usage: node test/fixtures/spawns-a-grandchild.ts <marker-path>
import { spawn } from 'node:child_process';
import process from 'node:process';

const [marker] = process.argv.slice(2);
// Appends forever, so the test can tell "still running" from "stopped" by watching the file grow.
const grandchild = spawn(
  process.execPath,
  [
    '-e',
    `const fs = require('fs'); setInterval(() => fs.appendFileSync(${JSON.stringify(marker)}, 'x'), 50);`,
  ],
  { stdio: 'ignore' },
);

console.log(`grandchild ${grandchild.pid}`);
setInterval(() => {}, 1_000);
