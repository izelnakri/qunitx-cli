import { promisify } from 'node:util';
import { exec } from 'node:child_process';
import addBorderToText from '../helpers/add-border-to-text.js';

const shell = promisify(exec);

export default async function execute(commandString, { moduleName = '', testName = '' } = {}) {
  try {
  let pidColor = generateRandomHexColor();
    let result = await shell(commandString);
    let { stdout, stderr } = result;

    console.trace(addBorderToText(`
      TEST NAME: ${moduleName} | ${testName}
      TEST COMMAND: ${commandString}
      ${stdout.split('\n').map((line, index) => `${index}: ${line}`).join('\n')}
    `, pidColor));

    if (stderr && stderr !== '') {
      console.trace(addBorderToText(`
        TEST NAME: ${moduleName} | ${testName}
        TEST COMMAND: ${commandString}
        ${stderr.split('\n').map((line, index) => `${index}: ${line}`).join('\n')}
      `, '#FF0000'));
    }

    return Object.assign(result, { pidColor });
  } catch (error) {
    console.trace(addBorderToText(`
      ERROR TEST Name: ${moduleName} | ${testName}
      ERROR TEST COMMAND: ${commandString}
      ${error}
    `, '#FF0000'));

    throw error;;
  }
}

export function spawnProcess(commandString, _options) {
  let options = { timeout: 10000, moduleName: '', testName: '', ..._options };
  let stdout = [];
  let childProcess = exec(commandString, options);
  let pidColor = generateRandomHexColor();

  childProcess.stdout.on('data', (data) => stdout.push(data));
  childProcess.stderr.on('data', (data) => console.log(addBorderToText(`PROCESS STDERR ERROR:\n${data}`, '#FF0000')));

  return new Promise((resolve) => {
    let timeoutFunction = setTimeout(() => {
      console.trace(addBorderToText(`!!! PROCESS TIMEOUT: ${commandString}\n${stdout.join('')}`, '#FF0000'));
      return resolve(Object.assign(childProcess, { stdoutText: stdout.join(''), pidColor }));
    }, 20000);

    childProcess.stdout.on('data', (data) => {
      if (data.includes('# duration')) {
        clearTimeout(timeoutFunction);
        console.log(addBorderToText(`COMMAND: ${commandString}\n${stdout.join('')}`, pidColor));
        resolve(Object.assign(childProcess, { stdoutText: stdout.join(''), pidColor }));
      }
    });

    childProcess.on('close', () => {
      clearTimeout(timeoutFunction);
      resolve(Object.assign(childProcess, { stdoutText: stdout.join(''), pidColor }));
    });

    childProcess.on('error', (error) => {
      clearTimeout(timeoutFunction);
      console.error(addBorderToText(`!!! PROCESS ERROR: ${commandString}\n${stdout.join('')}`, '#FF0000'));
      resolve(Object.assign(childProcess, { stdoutText: stdout.join(''), pidColor }));
    });

    childProcess.on('exit', (code) => {
      clearTimeout(timeoutFunction);
      resolve(Object.assign(childProcess, { stdoutText: stdout.join(''), pidColor }));
    });
  });
}

function generateRandomHexColor() {
  // Generate a random hue value avoiding red/orange (0°-60°)
  // We'll map the random number 0-7 to hues: [80°, 120°, ... , 320°]
  const hueDegree = 80 + (Math.floor(Math.random() * 8) * 40);
  const hueRad = hueDegree * (Math.PI / 180);

  const r = Math.round(Math.sin(hueRad) * 127.5 + 127.5);
  const g = Math.round(Math.sin(hueRad + 2 * Math.PI / 3) * 127.5 + 127.5);
  const b = Math.round(Math.sin(hueRad + 4 * Math.PI / 3) * 127.5 + 127.5);

  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase()}`;
}
