import net from 'node:net';

// TCP port of the in-process semaphore server started by test/runner.ts.
// Absent when a single test file is run directly (e.g. `node test/flags/timeout-test.ts`).
const port = process.env.QUNITX_SEMAPHORE_PORT ? Number(process.env.QUNITX_SEMAPHORE_PORT) : null;

export interface BrowserPermit {
  release(): void;
}

/**
 * Acquires one browser concurrency slot from the semaphore queue server.
 *
 * The semaphore is a throttle ceiling: tests run with { concurrency: true } so many
 * browser instances would launch simultaneously. This caps active instances at
 * availableParallelism() so the machine stays responsive and runtimes stay predictable
 * for developers — rather than all browsers thrashing each other and degrading together.
 * Applies to all browser engines (chromium, firefox, webkit).
 *
 * Protocol: open a TCP connection, send one byte; server replies with 'ok' when a slot
 * is available. The slot is held until `permit.release()` destroys the socket.
 *
 * Returns a no-op permit when QUNITX_SEMAPHORE_PORT is unset (single-file run).
 */
export function acquireBrowser(): Promise<BrowserPermit> {
  if (!port) return Promise.resolve({ release: () => {} });
  return new Promise<BrowserPermit>((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.once('error', reject);
    socket.once('data', () => resolve({ release: () => socket.destroy() }));
    socket.write('r');
  });
}
