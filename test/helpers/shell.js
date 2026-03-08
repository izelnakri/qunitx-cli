import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';

const shell = promisify(exec);

export default async function execute(commandString, { moduleName = '', testName = '' } = {}) {
  // Each browser test run gets its own output dir so parallel runs never clobber each other.
  // Only applied when the command targets cli.js and doesn't already specify --output.
  let command = commandString;
  if (/\bnode cli\.js\b/.test(command) && !/--output/.test(command)) {
    command = `${command} --output=tmp/run-${randomUUID()}`;
  }

  try {
    let result = await shell(command);
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
