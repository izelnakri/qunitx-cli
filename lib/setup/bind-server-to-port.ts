import type HTTPServer from '../servers/http.ts';

/**
 * Binds an HTTPServer to an OS-assigned port and writes the resolved port back to `config.port`.
 * @returns {Promise<object>}
 */
export default async function bindServerToPort(
  server: HTTPServer,
  config: { port: number },
): Promise<HTTPServer> {
  await server.listen(0);
  config.port = (server._server.address() as import('node:net').AddressInfo).port;
  return server;
}
