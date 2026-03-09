export default async function bindServerToPort(server, config) {
  await server.listen(0);
  config.port = server._server.address().port;
  return server;
}
