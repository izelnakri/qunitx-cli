/**
 * Benchmarks HTTP + WebSocket server lifecycle — creation and port binding.
 * This runs on every test-runner startup, so its cost adds directly to time-to-first-test.
 */
import HTTPServer from "../lib/servers/http.js";
import bindServerToPort from "../lib/setup/bind-server-to-port.js";

function closeServer(server: InstanceType<typeof HTTPServer>): Promise<void> {
  return new Promise((resolve) => {
    server.wss.close(() => {
      server._server.close(() => resolve());
    });
  });
}

Deno.bench("server: create HTTPServer instance", {
  group: "server",
  baseline: true,

}, () => {
  // deno-lint-ignore no-new
  new HTTPServer();
});

Deno.bench("server: create + bind to OS port + close", {
  group: "server",

}, async () => {
  const server = new HTTPServer();
  const config: { port?: number } = {};
  await bindServerToPort(server, config);
  await closeServer(server);
});
