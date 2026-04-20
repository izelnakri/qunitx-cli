import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChrome } from './find-chrome.ts';
import type { Config } from '../types.ts';

/**
 * Opens the test output in the browser qunitx uses, detached from the qunitx process.
 * In watch mode, opens the live HTTP server URL so WebSocket-driven reloads work on file changes.
 * In normal mode, opens the static file:// URL (the bundle is self-contained, no server needed).
 * If config.open is a string, it is used as the browser binary/command directly (e.g. 'brave', 'google-chrome-lts').
 */
export async function openOutputInBrowser(config: Config): Promise<void> {
  try {
    const outputFile = config.watch
      ? `http://localhost:${config.port}`
      : pathToFileURL(path.join(path.resolve(config.projectRoot, config.output), 'index.html'))
          .href;

    if (typeof config.open === 'string') {
      spawnDetached(config.open, [outputFile]);
      return;
    }

    const browserName = config.browser || 'chromium';

    if (browserName === 'firefox') {
      spawnDetached('firefox', [outputFile]);
      return;
    }
    if (browserName === 'webkit') {
      if (process.platform === 'darwin') spawnDetached('open', ['-a', 'Safari', outputFile]);
      return;
    }

    const chromePath =
      (await findChrome()) ?? (await import('playwright-core')).chromium.executablePath();
    if (chromePath) spawnDetached(chromePath, [outputFile]);
  } catch (err) {
    console.error('# Warning: --open could not launch browser:', err);
  }
}

function spawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // suppress ENOENT / sandbox errors — viewer Chrome is best-effort
  child.unref();
}

export { openOutputInBrowser as default };
