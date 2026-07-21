import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

// On Windows, look for the .exe variants too — accessSync(X_OK) on Windows treats any
// existing file as executable, but Windows-only chrome binaries don't appear under bare
// names in PATH directories.
const CANDIDATES =
  process.platform === 'win32'
    ? ['chrome.exe', 'chromium.exe', 'google-chrome.exe']
    : ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];
// path.delimiter is ':' on POSIX and ';' on Windows — splitting on a hardcoded ':' would
// produce one nonsense entry like 'C' from 'C:\\Program Files\\...' on Windows.
const PATH_DIRS = (process.env.PATH || '').split(delimiter).filter(Boolean);

/**
 * Resolves the Chrome/Chromium executable path. Returns a Promise for API compatibility
 * with callers, but the resolution is synchronous.
 * @returns {Promise<string|null>}
 */
export function findChrome(): Promise<string | null> {
  return Promise.resolve(findChromeSync());
}

export { findChrome as default };

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
