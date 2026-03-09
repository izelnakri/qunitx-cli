import { exec } from 'node:child_process';

const CANDIDATES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];

export default async function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  return Promise.any(
    CANDIDATES.map(
      (name) =>
        new Promise((resolve, reject) =>
          exec(`which ${name}`, (err, stdout) => (err ? reject() : resolve(stdout.trim()))),
        ),
    ),
  ).catch(() => null);
}
