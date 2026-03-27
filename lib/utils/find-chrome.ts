import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';

const CANDIDATES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];
const PATH_DIRS = (process.env.PATH || '').split(':').filter(Boolean);

/**
 * Synchronously resolves the Chrome/Chromium executable path from `CHROME_BIN` or by probing
 * common binary names in PATH directories using accessSync.
 * Synchronous to avoid I/O saturation during the module-loading phase, which would cause async
 * fs.access/exec-based approaches to be delayed by hundreds of milliseconds.
 * @returns {string|null}
 */
function findChromeSync(): string | null {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  for (const dir of PATH_DIRS) {
    for (const name of CANDIDATES) {
      const fullPath = join(dir, name);
      try {
        accessSync(fullPath, constants.X_OK);
        return fullPath;
      } catch {
        // not found or not executable, try next
      }
    }
  }
  return null;
}

/**
 * Resolves the Chrome/Chromium executable path. Returns a Promise for API compatibility
 * with callers, but the resolution is synchronous.
 * @returns {Promise<string|null>}
 */
export default function findChrome(): Promise<string | null> {
  return Promise.resolve(findChromeSync());
}
