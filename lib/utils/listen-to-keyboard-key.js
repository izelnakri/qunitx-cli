import process from 'node:process';

const stdin = process.stdin;
const targetInputs = {};
const inputs = [];
let listenerAdded = false;

/**
 * Registers a stdin listener that fires `closure` when the user types `inputString` (case-insensitive by default).
 * @returns {void}
 */
export default function listenToKeyboardKey(
  inputString,
  closure,
  options = { caseSensitive: false },
) {
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  if (!listenerAdded) {
    stdin.on('data', function (key) {
      if (key === '\u0003') {
        process.exit(); // so node process doesnt trap Control-C
      }

      inputs.shift();
      inputs.push(key);

      const currentInput = inputs.join('');
      const targetListener = targetInputs[currentInput.toUpperCase()];
      if (targetListener && targetListenerConformsToCase(targetListener, currentInput)) {
        targetListener.closure(currentInput);
        inputs.fill(undefined);
      }
    });
    listenerAdded = true;
  }

  if (inputString.length > inputs.length) {
    inputs.length = inputString.length;
  }

  targetInputs[inputString.toUpperCase()] = Object.assign(options, { closure });
}

function targetListenerConformsToCase(targetListener, inputString) {
  if (targetListener.caseSensitive) {
    return inputString === inputString.toUpperCase();
  }

  return true;
}
