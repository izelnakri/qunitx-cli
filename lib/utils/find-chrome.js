import { exec } from 'node:child_process';

const CANDIDATES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];

/**
 * Resolves the Chrome/Chromium executable path from `CHROME_BIN` or by probing common binary names.
 * @returns {Promise<string|null>}
 */
export default function findChrome() {
  if (process.env.CHROME_BIN) return Promise.resolve(process.env.CHROME_BIN);

  return Promise.any(
    CANDIDATES.map(
      (name) =>
        new Promise((resolve, reject) =>
          exec(`which ${name}`, (err, stdout) => (err ? reject() : resolve(stdout.trim()))),
        ),
    ),
  ).catch(() => null);
}
