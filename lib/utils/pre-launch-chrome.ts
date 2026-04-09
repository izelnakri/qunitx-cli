import { spawn } from 'node:child_process';
import type { EarlyChrome } from '../types.ts';

const CDP_URL_REGEX = /DevTools listening on (ws:\/\/[^\s]+)/;

/**
 * Spawns a headless Chrome process with remote-debugging-port=0 and resolves once the
 * CDP WebSocket endpoint is printed to stderr. Returns null if Chrome is unavailable or
 * fails to start, so callers can fall back to playwright's normal launch.
 * @returns {Promise<{proc: ChildProcess, cdpEndpoint: string} | null>}
 */
export default function preLaunchChrome(
  chromePath: string | null | undefined,
  args: string[],
  headless = true,
): Promise<EarlyChrome | null> {
  if (!chromePath) return Promise.resolve(null);

  const headlessArgs = headless ? ['--headless=new'] : [];
  return new Promise((resolve) => {
    const proc = spawn(chromePath, ['--remote-debugging-port=0', ...headlessArgs, ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let buffer = '';
    proc.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(CDP_URL_REGEX);
      if (match) {
        // Unref so Chrome's process + stderr pipe don't keep the Node.js event loop alive
        // after all test work is done. Chrome is still killed via process.on('exit').
        proc.unref();
        proc.stderr.unref();
        resolve({ proc, cdpEndpoint: match[1] });
      }
    });

    // Resolve null on any startup failure so launchBrowser falls back to chromium.launch().
    // The close handler resolves unconditionally: if Chrome exits before printing its CDP URL
    // (code=0 for a clean exit, code=null for a signal-killed process such as OOM on CI),
    // the original condition `code !== null && code !== 0` would leave the promise pending
    // forever, causing launchBrowser to hang and the event loop to drain silently (exit 0).
    // If Chrome already printed its URL and the promise is resolved, this is a no-op.
    proc.on('error', () => resolve(null));
    proc.on('close', () => resolve(null));
  });
}
