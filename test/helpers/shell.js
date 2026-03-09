import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';
import { availableParallelism } from 'node:os';

const shell = promisify(exec);

// Chrome is the concurrency bottleneck: each CLI invocation launches a browser,
// so parallelism is CPU-bound, not I/O-bound. Test modules use the default
// sequential behaviour (concurrency: false is Node's default for subtests).
// File-level parallelism via --test-concurrency already gives the maximum safe
// throughput. This throttle guards against accidental overload if concurrency
// is ever re-enabled on a module.
const MAX_CONCURRENT = Math.max(1, availableParallelism() - 1);
let running = 0;
const queue = [];

function throttle(fn) {
  if (running < MAX_CONCURRENT) {
    running++;
    return fn().finally(() => {
      running--;
      if (queue.length > 0) queue.shift()();
    });
  }
  return new Promise((resolve, reject) => {
    queue.push(() => throttle(fn).then(resolve, reject));
  });
}

export default async function execute(commandString, { moduleName = '', testName = '' } = {}) {
  // Each browser test run gets its own output dir so parallel runs never clobber each other.
  // Only applied when the command targets cli.js and doesn't already specify --output.
  let command = commandString;
  if (/\bnode cli\.js\b/.test(command) && !/--output/.test(command)) {
    command = `${command} --output=tmp/run-${randomUUID()}`;
  }

  try {
    let result = await throttle(() => shell(command, { timeout: 60000 }));
    let { stdout, stderr } = result;

    console.trace(`
      TEST NAME: ${moduleName} | ${testName}
      TEST COMMAND: ${command}
      ${stdout
        .split('\n')
        .map((line, index) => `${index}: ${line}`)
        .join('\n')}
    `);

    if (stderr && stderr !== '') {
      console.trace(`
        TEST NAME: ${moduleName} | ${testName}
        TEST COMMAND: ${command}
        ${stderr
          .split('\n')
          .map((line, index) => `${index}: ${line}`)
          .join('\n')}
      `);
    }

    return result;
  } catch (error) {
    console.trace(`
      ERROR TEST Name: ${moduleName} | ${testName}
      ERROR TEST COMMAND: ${command}
      ${error}
    `);

    throw error;
  }
}
