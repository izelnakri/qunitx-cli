import process from 'node:process';
import { spawn } from 'node:child_process';

/**
 * Hands an address to whatever this desktop opens addresses with — the browser already running.
 *
 * `xdg-open`, `open` and `start` are the same idea under three names, and the point of using them
 * rather than launching a browser is that they land in the window that is already open, logged in,
 * and has your tabs in it.
 *
 * Detached and with its output thrown away: a desktop opener is a doorbell, not a program this
 * session waits on, and some of them chatter on stderr while doing exactly what was asked.
 *
 * ```ts
 * import { openInBrowser } from './desktop.ts';
 *
 * // Defined, not invoked: it puts a window on somebody's screen.
 * function example() {
 *   return openInBrowser('https://localhost:1234'); // null once handed over
 * }
 * ```
 */
export function openInBrowser(address: string): Promise<string | null> {
  const opener = OPENERS[process.platform] ?? OPENERS.default;
  if (!opener) return Promise.resolve(`no way to open ${address} on ${process.platform}\n`);

  return new Promise((resolve) => {
    const [command, ...args] = opener;
    const child = spawn(command as string, [...args, address], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => resolve(`${command} could not be started\n`));
    child.unref();
    // Answered as soon as it is running: what it does next belongs to the desktop, not to this
    // prompt, and waiting for a browser window to close is not a thing anybody meant by `.open`.
    setTimeout(() => resolve(null), 0);
  });
}

/** What each desktop calls its opener. `start` is a shell builtin, so it needs one. */
const OPENERS: Record<string, string[] | undefined> = {
  darwin: ['open'],
  win32: ['cmd', '/c', 'start', ''],
  default: ['xdg-open'],
};

/**
 * Whether this is an address rather than a path — what a browser takes and an editor does not.
 *
 * ```ts
 * import { isAddress } from './desktop.ts';
 *
 * isAddress('https://localhost:1234'); // true
 * isAddress('lib/repl/session.ts'); // false — a path, whether or not there is a file there yet
 * ```
 */
export function isAddress(target: string): boolean {
  return /^(?:https?|file|about|chrome):/i.test(target) || /^www\./i.test(target);
}
