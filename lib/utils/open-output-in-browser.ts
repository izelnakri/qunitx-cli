import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as Chrome from '../chrome/index.ts';
import { buildQUnitFilterQuery } from '../selection/filter.ts';
import { Task } from '../task/index.ts';
import type { Config } from '../types.ts';

/**
 * Opens the test output in the browser qunitx uses, detached from the qunitx process.
 * In watch mode, opens the live HTTP server URL so WebSocket-driven reloads work on file changes.
 * In normal mode, opens the static file:// URL (the bundle is self-contained, no server needed).
 * If config.open is a string, it is used as the browser binary/command directly (e.g. 'brave', 'google-chrome-lts').
 *
 * ```ts
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: spawns a detached browser process.
 * async function maybeOpen(config: Config) {
 *   if (config.open) await openOutputInBrowser(config); // watch mode → live URL; else file://
 * }
 * ```
 */
export function openOutputInBrowser(config: Config): Task<void, never> {
  // A viewer window is a convenience, so every way it can fail — no such binary, no Chrome to
  // find, a sandbox that refuses the spawn — is one warning and a run that carries on. Stating
  // that once here is what lets the launch itself read straight down.
  return Task(() => launch(config)).recover((error) => {
    console.error('# Warning: --open could not launch browser:', error);
  });
}

async function launch(config: Config): Promise<void> {
  // The filter query rides along so the opened window shows the same tests the terminal ran.
  // QUnit reads it from location.search, which file:// URLs carry just like http:// ones.
  const outputFile =
    (config.watch
      ? `http://localhost:${config.port}`
      : pathToFileURL(path.join(path.resolve(config.projectRoot, config.output), 'index.html'))
          .href) + buildQUnitFilterQuery(config);

  if (typeof config.open === 'string') return spawnDetached(config.open, [outputFile]);

  const browserName = config.browser || 'chromium';

  if (browserName === 'firefox') {
    spawnDetached('firefox', [outputFile]);
  } else if (browserName === 'webkit') {
    if (process.platform === 'darwin') spawnDetached('open', ['-a', 'Safari', outputFile]);
  } else {
    const chromePath =
      (await Chrome.find()) ?? (await import('playwright-core')).chromium.executablePath();
    if (chromePath) spawnDetached(chromePath, [outputFile]);
  }
}

function spawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // suppress ENOENT / sandbox errors — viewer Chrome is best-effort
  child.unref();
}
