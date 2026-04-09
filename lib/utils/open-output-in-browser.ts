import { spawn } from 'node:child_process';
import findChrome from './find-chrome.ts';
import type { Config } from '../types.ts';

/**
 * Opens the built static test output in the browser qunitx uses, detached from the qunitx process.
 * The static index.html has the full test bundle inlined — QUnit runs without needing the server.
 * If config.open is a string, it is used as the browser binary/command directly (e.g. 'brave', 'google-chrome-lts').
 */
export default async function openOutputInBrowser(config: Config): Promise<void> {
  const outputFile = `file://${config.projectRoot}/${config.output}/index.html`;

  if (typeof config.open === 'string') {
    spawn(config.open, [outputFile], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  const browserName = config.browser || 'chromium';

  if (browserName === 'firefox')
    return void spawn('firefox', [outputFile], { detached: true, stdio: 'ignore' }).unref();
  if (browserName === 'webkit') {
    if (process.platform === 'darwin')
      spawn('open', ['-a', 'Safari', outputFile], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  const chromePath =
    (await findChrome()) ?? (await import('playwright-core')).chromium.executablePath();
  if (chromePath) spawn(chromePath, [outputFile], { detached: true, stdio: 'ignore' }).unref();
}
