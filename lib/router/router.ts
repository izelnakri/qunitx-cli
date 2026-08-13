/**
 * `router` — the HTTP edge, Express-shaped on **web standards**: `app.get('/todos/:id', h)`,
 * middleware via `app.use`, path params, and JSON helpers — but a handler takes a standard
 * `Request` and returns a standard `Response`, so ONE app object serves every runtime with no
 * framework coupling:
 *
 *  - **Deno**: `Deno.serve(app.fetch)` — nothing else.
 *  - **Node**: `nodeListen(app, port)` (see `./node.ts` — a thin `node:http` adapter, Node-only).
 *  - **Tests**: call `app.fetch(new Request(...))` directly — the app IS a pure function, no
 *    socket needed (the same trick as the long-poll endpoint).
 *
 * This is the Plug/Router role in the Phoenix mapping: the stateless edge in front of the
 * distributed core — handlers route to entity actors (`via:`), throttle with `rateLimiter`,
 * span with `Telemetry`, and the router itself stays a request→response function.
 *
 * ```ts
 * const app = router();
 * app.get('/hello/:name', (req) => json({ hello: req.params.name }));
 * const res = await app.fetch(new Request('http://x/hello/ada'));
 * await res.json(); // { hello: 'ada' }
 * ```
 */

/** A standard `Request` enriched with the route's path params and parsed query. */
export type RouteRequest = Request & {
  /** Captures from `:name` segments, e.g. `/todos/:id` → `{ id: '7' }`. */
  params: Record<string, string>;
  /** The URL's query string, as a plain object (last value wins). */
  query: Record<string, string>;
};

/** A route or middleware handler: standard Request in (with params), standard Response out. */
export type Handler = (
  request: RouteRequest,
  next: () => Promise<Response>,
) => Response | Promise<Response>;

/** The Express-shaped app — register routes, then serve `fetch` anywhere. */
export interface Router {
  /** Register a GET route. `path` supports `:param` segments and a trailing `*` wildcard. */
  get(path: string, handler: Handler): Router;
  /** Register a POST route. */
  post(path: string, handler: Handler): Router;
  /** Register a PUT route. */
  put(path: string, handler: Handler): Router;
  /** Register a PATCH route. */
  patch(path: string, handler: Handler): Router;
  /** Register a DELETE route. */
  delete(path: string, handler: Handler): Router;
  /** Register middleware that runs before every route — call `next()` to continue the chain. */
  use(middleware: Handler): Router;
  /** The whole app as one standard `Request → Response` function — serve it anywhere. */
  fetch(request: Request): Promise<Response>;
}

/**
 * JSON response helper — `res.json(...)`, web-standard flavored.
 *
 * ```ts
 * const res = json({ ok: true }, 201);
 * res.status; // 201
 * ```
 */
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Route {
  method: string;
  segments: string[]; // '/todos/:id' -> ['todos', ':id']
  handler: Handler;
}

const match = (route: Route, path: string[]): Record<string, string> | null => {
  const params: Record<string, string> = {};
  for (let i = 0; i < route.segments.length; i++) {
    const segment = route.segments[i];
    if (segment === '*') return params; // wildcard swallows the rest
    if (i >= path.length) return null;
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(path[i]);
    else if (segment !== path[i]) return null;
  }
  return route.segments.length === path.length ? params : null;
};

/**
 * Build a {@link Router}. Unmatched requests get a JSON 404; a handler that throws gets a JSON
 * 500 (the error is not leaked to the client). Middleware composes in registration order.
 *
 * ```ts
 * const app = router();
 * app.use(async (req, next) => {
 *   const res = await next();
 *   res.headers.set('x-served-by', 'qunitx');
 *   return res;
 * });
 * app.post('/echo', async (req) => json(await req.json(), 201));
 * const res = await app.fetch(
 *   new Request('http://x/echo', { method: 'POST', body: JSON.stringify({ a: 1 }) }),
 * );
 * res.status; // 201
 * res.headers.get('x-served-by'); // 'qunitx'
 * ```
 */
export function router(): Router {
  const routes: Route[] = [];
  const middleware: Handler[] = [];

  const dispatch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname.split('/').filter(Boolean);
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;

    // Find the matching route (first registered wins, Express-style).
    let matched: { route: Route; params: Record<string, string> } | null = null;
    for (const route of routes) {
      if (route.method !== request.method) continue;
      const params = match(route, path);
      if (params) {
        matched = { route, params };
        break;
      }
    }
    const enriched = Object.assign(request, {
      params: matched?.params ?? {},
      query,
    }) as RouteRequest;

    // Compose: middleware in order, then the route (or 404) as the innermost link.
    const terminal = (): Promise<Response> =>
      matched
        ? Promise.resolve(matched.route.handler(enriched, () => terminal()))
        : Promise.resolve(json({ error: 'not found' }, 404));
    const chain = middleware.reduceRight<() => Promise<Response>>(
      (next, layer) => () => Promise.resolve(layer(enriched, next)),
      terminal,
    );
    try {
      return await chain();
    } catch {
      return json({ error: 'internal error' }, 500); // a throwing handler never leaks details
    }
  };

  const app: Router = {
    get: (path, handler) => add('GET', path, handler),
    post: (path, handler) => add('POST', path, handler),
    put: (path, handler) => add('PUT', path, handler),
    patch: (path, handler) => add('PATCH', path, handler),
    delete: (path, handler) => add('DELETE', path, handler),
    use(layer) {
      middleware.push(layer);
      return app;
    },
    fetch: dispatch,
  };
  const add = (method: string, path: string, handler: Handler): Router => {
    routes.push({ method, segments: path.split('/').filter(Boolean), handler });
    return app;
  };
  return app;
}
