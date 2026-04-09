import type HTTPServer from '../servers/http.ts';

/**
 * Binds an HTTPServer to `config.port` (default 1234), incrementing on EADDRINUSE unless the
 * port was explicitly set by the user (config.portExplicit), in which case it throws.
 * Uses try-catch on the actual listen() call to avoid TOCTOU races.
 * @returns {Promise<object>}
 */
export default async function bindServerToPort(
  server: HTTPServer,
  config: { port: number; portExplicit?: boolean },
): Promise<HTTPServer> {
  let port = config.port;

  while (true) {
    try {
      await server.listen(port);
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && !config.portExplicit) {
        port++;
        continue;
      }
      throw err;
    }
  }

  config.port = (server._server.address() as import('node:net').AddressInfo).port;
  return server;
}
