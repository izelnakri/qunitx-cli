/**
 * Binds an HTTPServer to an OS-assigned port and writes the resolved port back to `config.port`.
 * @returns {Promise<object>}
 */
export default async function bindServerToPort(server, config) {
  await server.listen(0);
  config.port = server._server.address().port;
  return server;
}
