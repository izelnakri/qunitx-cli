/**
 * The Node binding for {@link router} (Node-only — it stands on `node:http`, so it is
 * deliberately NOT exported from the barrel; the router itself is universal). Deno needs no
 * binding at all: `Deno.serve(app.fetch)`.
 *
 * ```ts
 * // Defined, not invoked: binds a real port.
 * import { router } from './router.ts';
 * function boot(port: number) {
 *   return nodeListen(router(), port); // read .port() back; .close() to stop
 * }
 * ```
 */
import { createServer, type IncomingMessage } from 'node:http';
import type { Router } from './router.ts';

const toRequest = (req: IncomingMessage): Request => {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : req;
  return new Request(url, {
    method,
    headers: Object.entries(req.headers).map(([k, v]) => [k, String(v)] as [string, string]),
    // node:http gives the body as a stream; Request accepts it with half-duplex declared.
    body: body as unknown as BodyInit,
    ...(body ? { duplex: 'half' } : {}),
  });
};

/**
 * Serve `app` on `port` over `node:http`, converting each incoming message to a standard
 * `Request` and streaming the standard `Response` back. Returns the bound port and a close.
 *
 * ```ts
 * // Defined, not invoked: binds a real port.
 * import { router } from './router.ts';
 * function ephemeral() {
 *   return nodeListen(router(), 0); // OS-assigned
 * }
 * ```
 */
export function nodeListen(
  app: Router,
  port: number,
): { port: () => number; close: () => Promise<void> } {
  const server = createServer((req, res) => {
    void app
      .fetch(toRequest(req))
      .then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
      })
      .catch(() => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"internal error"}');
      });
  });
  server.listen(port);
  return {
    port: () => (server.address() as { port: number }).port,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections?.();
      }),
  };
}
