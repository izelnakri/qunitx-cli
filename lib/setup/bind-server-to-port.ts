import { Task } from '../task/index.ts';
import type { HTTPServer } from '../web/index.ts';

// Maximum number of retries when an explicitly requested port is transiently occupied.
// Covers the TOCTOU window between findFreePort() and the CLI's own bind: another concurrent
// process may grab the port in that gap. Each retry waits RETRY_DELAY_MS before trying again.
// A genuinely occupied port (held indefinitely) exhausts all retries and still throws.
//
// Budget: 20 retries × 50ms = 1000ms total. This covers the CLI startup window (~300–800ms on a
// loaded CI machine) between the test releasing the port and bindServerToPort actually running.
const EXPLICIT_PORT_RETRIES = 20;
const EXPLICIT_PORT_RETRY_DELAY_MS = 50;

/**
 * Binds an HTTPServer to `config.port` (default 1234).
 * - Auto-port (portExplicit false): increments on EADDRINUSE until a free port is found.
 * - Explicit port (portExplicit true): retries up to EXPLICIT_PORT_RETRIES times on EADDRINUSE
 *   to recover from transient TOCTOU races, then throws if still occupied.
 * Uses try-catch on the actual listen() call — never check-then-listen (TOCTOU).
 *
 * ```ts
 * import type { HTTPServer } from '../web/index.ts';
 *
 * // Defined, not invoked: binds a real port.
 * async function bind(server: HTTPServer, config: { port: number; portExplicit?: boolean }) {
 *   await bindServerToPort(server, config);
 *   return config.port; // updated in place to the port actually bound
 * }
 * ```
 */
export async function bindServerToPort(
  server: HTTPServer,
  config: { port: number; portExplicit?: boolean },
  // Injectable so the retry path is unit-testable without paying real wall-clock delays. A
  // number rather than a sleep function now that `retry` owns the waiting — a fake sleep would
  // be silently ignored, which is worse than no seam at all.
  retryDelayMs: number = EXPLICIT_PORT_RETRY_DELAY_MS,
): Promise<HTTPServer> {
  const inUse = (error: unknown) => (error as NodeJS.ErrnoException).code === 'EADDRINUSE';

  if (config.portExplicit) {
    // Policy A — the caller named a port, so the only thing to wait out is the TOCTOU window.
    // Same work, retried: `when` keeps that to EADDRINUSE, so any other listen error still
    // surfaces on the first attempt instead of after a second of pointless waiting.
    await Task(() => server.listen(config.port)).retry(EXPLICIT_PORT_RETRIES, {
      delayMs: retryDelayMs,
      when: inUse,
    });
  } else {
    // Policy B — no port was named, so this is a SEARCH, not a retry: each attempt uses a
    // different input, which is precisely what `retry` cannot express. Left as the loop it is.
    for (let port = config.port; ; port++) {
      // `recover`, not `result`: an EADDRINUSE from node:net is a plain Error, and the two-tier
      // rule means `result()` would rethrow it rather than hand it back. `null` is "bound".
      const failure = await Task(() => server.listen(port))
        .map(() => null)
        .recover((error) => error);
      if (failure === null) break;
      if (!inUse(failure)) throw failure;
    }
  }

  config.port = (server._server.address() as import('node:net').AddressInfo).port;
  return server;
}
