// A minimal express-like router over node:http — no framework dependency. Handlers return a
// Reply; the single write point maps a declared Failure to its HTTP status and keeps the
// cause chain in the log, never in the client body (don't educate attackers).
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { Failure } from '../../../lib/task/index.ts';
import { statusOf } from './failures.ts';

export type Reply =
  | { status: number; json: unknown }
  | { status: number; stream: ReadableStream<Uint8Array>; contentType: string };

export type Ctx = {
  req: IncomingMessage;
  params: Record<string, string>;
  query: URLSearchParams;
  body: () => Promise<unknown>;
};
type Handler = (ctx: Ctx) => Promise<Reply> | Reply;
type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler };

export function router() {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + path.replace(/:([^/]+)/g, (_m, k: string) => (keys.push(k), '([^/]+)')) + '$',
    );
    routes.push({ method, pattern, keys, handler });
  };

  const api = {
    get: (path: string, handler: Handler) => (add('GET', path, handler), api),
    post: (path: string, handler: Handler) => (add('POST', path, handler), api),
    listen: (port: number, onListen: (server: Server) => void) => {
      const server = createServer(async (req, res) => {
        const outcome = await handle(req).catch((bug): Reply => {
          console.error('BUG escaped a handler:', bug); // the one crash boundary
          return { status: 500, json: { error: 'internal error' } };
        });
        write(res, outcome);
      });
      server.listen(port, () => onListen(server));
      return server;
    },
  };

  const handle = async (req: IncomingMessage): Promise<Reply> => {
    const url = new URL(req.url ?? '/', 'http://internal');
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, match[i + 1]]));
      const ctx: Ctx = { req, params, query: url.searchParams, body: () => readJson(req) };
      const reply = await route.handler(ctx);
      return reply;
    }
    return { status: 404, json: { error: 'no route' } };
  };

  return api;
}

// Turn a settled `T | Failure` (from `task.result()`) into a Reply — the whole HTTP↔failure
// bridge in one function. A correlation id links the client's 503 to the full chain in logs.
export function replyFor<T>(outcome: T | Failure.Any, ok: (value: T) => Reply): Reply {
  if (!Failure.is(outcome)) return ok(outcome as T);
  const correlation = crypto.randomUUID();
  console.error(`[${correlation}]`, Failure.format(outcome));
  return { status: statusOf(outcome), json: { error: outcome.code, correlation } };
}

function write(res: ServerResponse, reply: Reply) {
  if ('stream' in reply) {
    res.writeHead(reply.status, { 'content-type': reply.contentType });
    // Pump the web ReadableStream into node's response — backpressure preserved.
    void pump(reply.stream, res);
  } else {
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.json));
  }
}

async function pump(stream: ReadableStream<Uint8Array>, res: ServerResponse) {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((r) => res.once('drain', r));
    }
  } finally {
    res.end();
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}
