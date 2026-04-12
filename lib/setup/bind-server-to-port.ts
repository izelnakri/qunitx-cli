import type HTTPServer from '../servers/http.ts';

// Maximum number of retries when an explicitly requested port is transiently occupied.
// Covers the TOCTOU window between findFreePort() and the CLI's own bind: another concurrent
// process may grab the port in that gap. Each retry waits RETRY_DELAY_MS before trying again.
// A genuinely occupied port (held indefinitely) exhausts all retries and still throws.
const EXPLICIT_PORT_RETRIES = 5;
const EXPLICIT_PORT_RETRY_DELAY_MS = 20;

/**
 * Binds an HTTPServer to `config.port` (default 1234).
 * - Auto-port (portExplicit false): increments on EADDRINUSE until a free port is found.
 * - Explicit port (portExplicit true): retries up to EXPLICIT_PORT_RETRIES times on EADDRINUSE
 *   to recover from transient TOCTOU races, then throws if still occupied.
 * Uses try-catch on the actual listen() call — never check-then-listen (TOCTOU).
 */
export default async function bindServerToPort(
  server: HTTPServer,
  config: { port: number; portExplicit?: boolean },
): Promise<HTTPServer> {
  let port = config.port;
  let attempt = 0;

  while (true) {
    try {
      await server.listen(port);
      break;
    } catch (err: unknown) {
      const isEADDRINUSE = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (!isEADDRINUSE) throw err;

      if (config.portExplicit) {
        if (attempt >= EXPLICIT_PORT_RETRIES) throw err;
        attempt++;
        await new Promise<void>((resolve) => setTimeout(resolve, EXPLICIT_PORT_RETRY_DELAY_MS));
      } else {
        port++;
      }
    }
  }

  config.port = (server._server.address() as import('node:net').AddressInfo).port;
  return server;
}
