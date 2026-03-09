import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';

const shell = promisify(exec);

// Cross-process semaphore: connect to the server started by test/setup.js.
// All test workers share a single global Chrome slot count via TCP.
let semaphorePort = null;
async function getPort() {
  if (!semaphorePort) {
    semaphorePort = parseInt(await readFile('tmp/.semaphore-port', 'utf8'), 10);
  }
  return semaphorePort;
}

async function acquireSlot() {
  const port = await getPort();
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(port, '127.0.0.1');
    let buf = '';
    sock.on('connect', () => sock.write('acquire\n'));
    sock.on('data', (data) => {
      buf += data.toString();
      if (buf.includes('ok')) resolve(sock);
    });
    sock.on('error', reject);
  });
}

function releaseSlot(sock) {
  return new Promise((resolve) => {
    sock.once('data', () => {
      sock.destroy();
      resolve();
    });
    sock.once('error', resolve);
    sock.write('release\n');
  });
}

export default async function execute(commandString, { moduleName = '', testName = '' } = {}) {
  // Each browser test run gets its own output dir so parallel runs never clobber each other.
  // Only applied when the command targets cli.js and doesn't already specify --output.
  let command = commandString;
  if (/\bnode cli\.js\b/.test(command) && !/--output/.test(command)) {
    command = `${command} --output=tmp/run-${randomUUID()}`;
  }

  const isBrowserCommand = /\bnode cli\.js\b/.test(commandString);
  const sock = isBrowserCommand ? await acquireSlot() : null;

  try {
    let result = await shell(command, { timeout: 60000 });
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
  } finally {
    if (sock) await releaseSlot(sock);
  }
}
