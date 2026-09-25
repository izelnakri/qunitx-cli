import { Buffer } from 'node:buffer';
import process from 'node:process';
import { HTTPServer } from '../../lib/web/index.ts';
import type { Request, Response } from '../../lib/web/index.ts';

/**
 * A users API to talk to: the one the REPL's request commands are tested against, and the one
 * `npm run api-test-server` starts for anybody walking through them by hand.
 *
 * ```
 * GET    /api/users        every user, with an `x-total` header
 * POST   /api/users        201 and the user it made, with a `location` header
 * GET    /api/users/:id    one user, or 404 with a reason
 * PUT    /api/users/:id    replaces it
 * PATCH  /api/users/:id    merges into it
 * DELETE /api/users/:id    removes it, and says which
 * ```
 *
 * Plus four routes that are not the API but the shapes a client has to survive — a real socket
 * rather than a stubbed `fetch` is the whole point, because these are what only a real one has:
 *
 * ```
 * ANY /echo-headers        the request's own headers, as JSON: what actually reached the server
 * GET /image               3,000 bytes of `image/png`, which is not for printing at a terminal
 * GET /big                 50,000 characters of `text/plain`, for meeting a cap
 * GET /forever             a reply that never finishes, for giving up on
 * ```
 *
 * Each call gets its own server AND its own copy of the users, so concurrent tests can create and
 * delete without seeing each other's work.
 *
 * ```ts
 * import { apiServer } from './api-server.ts';
 *
 * // Defined, not invoked: it binds a port.
 * async function example() {
 *   await using api = await apiServer();
 *
 *   return api.url; // 'http://127.0.0.1:<port>'
 * }
 * ```
 */
export async function apiServer(): Promise<{ url: string } & AsyncDisposable> {
  const server = createApi();
  await server.listen(0);
  const { port } = server._server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${port}`,
    async [Symbol.asyncDispose]() {
      // `close` also drops live connections, which is load-bearing here rather than tidy:
      // `/forever` holds a socket open on purpose, and waiting for it is the suite hanging.
      await server.close();
    },
  };
}

/** One user, which is all the API is about. */
export interface User {
  id: number;
  name: string;
  email: string;
}

/** What a request body parses to once {@link jsonBody} has read it. */
type RequestWithBody = Request & { body: unknown; raw: string };

const SEED: readonly User[] = [
  { id: 1, name: 'Ada', email: 'ada@example.com' },
  { id: 2, name: 'Grace', email: 'grace@example.com' },
];

const PORT = Number(process.env.PORT ?? 4000);

/**
 * The API as routes, on this project's own HTTP server — the same `get`/`post`/`use` an Express
 * app is written with, so it reads as the example it is rather than as a fixture.
 *
 * ```ts
 * import { createApi } from './api-server.ts';
 *
 * const api = createApi();
 * Object.keys(api.routes.GET).includes('/api/users/:id'); // true
 * await api.close();
 * ```
 */
export function createApi(): HTTPServer {
  // Per server, so one test creating a user is not another test's list. `structuredClone` because
  // PUT and PATCH replace the objects in it, and SEED is shared by every server in the process.
  const users: User[] = structuredClone(SEED) as User[];
  const server = new HTTPServer();

  server.use(jsonBody);

  server.get('/api/users', (_req, res) => {
    res.setHeader('x-total', String(users.length));
    res.json(users);
  });

  server.post('/api/users', (req, res) => {
    const sent = (req as RequestWithBody).body as Partial<User> | null;
    if (!sent || typeof sent !== 'object') return badRequest(res, 'a user is a JSON object');

    const created = { id: nextId(users), name: 'unnamed', email: '', ...sent } as User;
    users.push(created);
    res.statusCode = 201;
    res.setHeader('location', `/api/users/${created.id}`);
    res.json(created);
  });

  server.get('/api/users/:id', (req, res) => {
    const user = find(users, req.params.id);

    return user ? res.json(user) : notFound(res, req.params.id);
  });

  server.put('/api/users/:id', (req, res) => {
    const user = find(users, req.params.id);
    if (!user) return notFound(res, req.params.id);

    const sent = (req as RequestWithBody).body as Partial<User> | null;
    if (!sent || typeof sent !== 'object') return badRequest(res, 'a user is a JSON object');

    // PUT replaces: what is not sent is gone, which is the difference from PATCH below.
    Object.assign(user, { name: 'unnamed', email: '', ...sent, id: user.id });
    res.json(user);
  });

  server.patch('/api/users/:id', (req, res) => {
    const user = find(users, req.params.id);
    if (!user) return notFound(res, req.params.id);

    const sent = (req as RequestWithBody).body as Partial<User> | null;
    if (!sent || typeof sent !== 'object') return badRequest(res, 'a user is a JSON object');

    Object.assign(user, sent, { id: user.id });
    res.json(user);
  });

  server.delete('/api/users/:id', (req, res) => {
    const user = find(users, req.params.id);
    if (!user) return notFound(res, req.params.id);

    users.splice(users.indexOf(user), 1);
    res.json({ deleted: user.id });
  });

  // Not the API: the four answers a client has to handle, which a users API never gives.
  server.get('/echo-headers', echoHeaders);
  server.post('/echo-headers', echoHeaders);
  server.put('/echo-headers', echoHeaders);
  server.patch('/echo-headers', echoHeaders);
  server.delete('/echo-headers', echoHeaders);

  server.get('/image', (_req, res) => {
    res.setHeader('content-type', 'image/png');
    res.end(Buffer.alloc(3_000));
  });

  server.get('/big', (_req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.end('x'.repeat(50_000));
  });

  server.get('/forever', (_req, res) => {
    // Deliberately never ended: the socket stays open until the client gives up on it.
    res.setHeader('content-type', 'text/plain');
    res.flushHeaders();
  });

  return server;
}

/** `npm run api-test-server` — the same API, on a port you can point a prompt at. */
if (import.meta.main) {
  const server = createApi();
  await server.listen(PORT);
  process.stdout.write(
    `# users API on http://localhost:${PORT}\n` +
      `#   GET    /api/users\n` +
      `#   POST   /api/users          {"name":"Ada","email":"ada@example.com"}\n` +
      `#   GET    /api/users/:id\n` +
      `#   PUT    /api/users/:id      replaces\n` +
      `#   PATCH  /api/users/:id      merges\n` +
      `#   DELETE /api/users/:id\n` +
      `#   GET    /echo-headers  /image  /big  /forever\n`,
  );
}

/** Reads the whole body and parses it when it is JSON — `express.json()`, in the small. */
function jsonBody(req: Request, _res: Response, next: () => void): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => void chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    const withBody = req as RequestWithBody;
    withBody.raw = raw;
    // A body that is not JSON is not an error here — `/echo-headers` is sent plenty of them, and
    // the routes that need an object say so themselves.
    withBody.body = raw === '' ? null : parse(raw);
    next();
  });
}

function echoHeaders(req: Request, res: Response): void {
  res.json(req.headers);
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function find(users: User[], id: string | undefined): User | undefined {
  return users.find((user) => String(user.id) === id);
}

function nextId(users: User[]): number {
  return users.reduce((highest, user) => Math.max(highest, user.id), 0) + 1;
}

function notFound(res: Response, id: string | undefined): void {
  res.statusCode = 404;
  res.json({ error: `no user ${id}` });
}

function badRequest(res: Response, reason: string): void {
  res.statusCode = 400;
  res.json({ error: reason });
}
