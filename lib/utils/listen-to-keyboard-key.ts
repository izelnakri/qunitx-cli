import process from 'node:process';

const stdin = process.stdin;
const targetInputs: Record<string, { caseSensitive: boolean; closure: (input: string) => void }> =
  {};
const inputs: (string | undefined)[] = [];
let listenerAdded = false;

/**
 * Registers a stdin listener that fires `closure` when the user types `inputString` (case-insensitive by default).
 *
 * ```ts
 * // Defined, not invoked: puts the TTY in raw mode and leaves a persistent stdin listener.
 * function wireWatchMode(rerun: () => void) {
 *   listenToKeyboardKey('r', () => rerun()); // 'r' or 'R' reruns
 *   listenToKeyboardKey('Q', () => process.exit(0), { caseSensitive: true }); // only 'Q' quits
 * }
 * ```
 * @returns {void}
 */
export function listenToKeyboardKey(
  inputString: string,
  closure: (input: string) => void,
  options: { caseSensitive: boolean } = { caseSensitive: false },
): void {
  if (!stdin.isTTY) return;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  if (!listenerAdded) {
    stdin.on('data', function (chunk) {
      // setEncoding('utf8') above guarantees a string; the node types keep the Buffer union.
      const key = String(chunk);
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

function targetListenerConformsToCase(
  targetListener: { caseSensitive: boolean },
  inputString: string,
): boolean {
  if (targetListener.caseSensitive) {
    return inputString === inputString.toUpperCase();
  }

  return true;
}
