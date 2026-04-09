import http from 'node:http';
// @deno-types="npm:@types/ws"
import WebSocket, { WebSocketServer } from 'ws';
import bindServerToPort from '../setup/bind-server-to-port.ts';

declare module 'node:http' {
  interface IncomingMessage {
    send: (data: string) => void;
    path: string;
    query: Record<string, string>;
    params: Record<string, string>;
  }
  interface ServerResponse {
    json: (data: unknown) => void;
  }
}

type NodeServerWithWSS = http.Server & { wss: WebSocketServer };

/** Route handler function signature for registered GET/POST/etc. routes. */
export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void | Promise<void>;
/** Middleware function signature — call `next()` to continue the chain. */
export type Middleware = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: () => void,
) => void;

interface Route {
  path: string;
  handler: RouteHandler;
  paramNames: string[];
  isWildcard: boolean;
  paramValues?: string[];
}

/** Map of file extensions to their corresponding MIME type strings. */
export const MIME_TYPES: Record<string, string> = {
  html: 'text/html; charset=UTF-8',
  js: 'application/javascript',
  css: 'text/css',
  png: 'image/png',
  jpg: 'image/jpg',
  gif: 'image/gif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

/** Minimal HTTP + WebSocket server used to serve test bundles and push reload events. */
export default class HTTPServer {
  /** Registered routes keyed by HTTP method then path. */
  routes: Record<string, Record<string, Route>>;
  /** Registered middleware functions, applied in order before each route handler. */
  middleware: Middleware[];
  /** Underlying Node.js HTTP server instance. */
  _server: http.Server;
  /** WebSocket server attached to the HTTP server for live-reload broadcasts. */
  wss: WebSocketServer;

  /**
   * Creates and starts a plain `http.createServer` instance on the given port.
   * @returns {Promise<object>}
   */
  static serve(
    config: { port: number; onListen?: (s: object) => void; onError?: (e: Error) => void } = {
      port: 1234,
    },
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<http.Server> {
    const onListen = config.onListen || ((_server: object) => {});
    const onError = config.onError || ((_error: Error) => {});

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        return handler(req, res);
      });
      server
        .on('error', (error) => {
          onError(error);
          reject(error);
        })
        .once('listening', () => {
          onListen(Object.assign({ hostname: '127.0.0.1', server }, config));
          resolve(server);
        });
      (server as NodeServerWithWSS).wss = new WebSocketServer({ server });
      (server as NodeServerWithWSS).wss.on('error', (error: Error) => {
        console.log('# [WebSocketServer] Error:');
        console.trace(error);
      });

      bindServerToPort(server as unknown as HTTPServer, config as { port: number });
    });
  }

  constructor() {
    this.routes = {
      GET: {},
      POST: {},
      DELETE: {},
      PUT: {},
    };
    this.middleware = [];
    this._server = http.createServer((req, res) => {
      req.send = (data: string) => {
        res.setHeader('Content-Type', 'text/plain');
        res.end(data);
      };
      res.json = (data: unknown) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(data));
      };

      return this.#handleRequest(req, res);
    });
    this.wss = new WebSocketServer({ server: this._server });
    this.wss.on('error', (error) => {
      // EADDRINUSE is forwarded from the HTTP server during bindServerToPort retries — suppress it,
      // it is already handled there. Only log genuinely unexpected WebSocket errors.
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return;
      console.log('# [WebSocketServer] Error:');
      console.log(error);
    });
  }

  /**
   * Closes the underlying HTTP server and all active connections, returning a
   * Promise that resolves once the server is fully closed.
   * @returns {Promise<void>}
   */
  close(): Promise<void> {
    this._server.closeAllConnections?.();
    return new Promise((resolve) => this._server.close(resolve as () => void));
  }

  /** Registers a GET route handler. */
  get(path: string, handler: RouteHandler): void {
    this.#registerRouteHandler('GET', path, handler);
  }

  /**
   * Starts listening on the given port (0 = OS-assigned).
   * @returns {Promise<void>}
   */
  listen(port = 0, callback: () => void = () => {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this._server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this._server.off('error', onError);
        resolve(callback());
      };
      this._server.once('error', onError);
      this._server.once('listening', onListening);
      this._server.listen(port);
    });
  }

  /** Broadcasts a message to all connected WebSocket clients. */
  publish(data: string): void {
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  /** Registers a POST route handler. */
  post(path: string, handler: RouteHandler): void {
    this.#registerRouteHandler('POST', path, handler);
  }

  /** Registers a DELETE route handler. */
  delete(path: string, handler: RouteHandler): void {
    this.#registerRouteHandler('DELETE', path, handler);
  }

  /** Registers a PUT route handler. */
  put(path: string, handler: RouteHandler): void {
    this.#registerRouteHandler('PUT', path, handler);
  }

  /** Adds a middleware function to the chain. */
  use(middleware: Middleware): void {
    this.middleware.push(middleware);
  }

  #registerRouteHandler(method: string, path: string, handler: RouteHandler): void {
    if (!this.routes[method]) {
      this.routes[method] = {};
    }

    this.routes[method][path] = {
      path,
      handler,
      paramNames: this.#extractParamNames(path),
      isWildcard: path === '/*',
    };
  }

  #handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const { method, url } = req;
    const urlObj = new URL(url!, 'http://localhost');
    const pathname = urlObj.pathname;
    req.path = pathname;
    req.query = Object.fromEntries(urlObj.searchParams);
    const matchingRoute = this.#findRouteHandler(method!, pathname);

    if (matchingRoute) {
      req.params = this.#extractParams(matchingRoute, pathname);
      this.#runMiddleware(req, res, matchingRoute.handler);
    } else {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Not found');
    }
  }

  #runMiddleware(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    callback: RouteHandler,
  ): void {
    let index = 0;
    const next = () => {
      if (index >= this.middleware.length) {
        callback(req, res);
      } else {
        const middleware = this.middleware[index];
        index++;
        middleware(req, res, next);
      }
    };
    next();
  }

  #findRouteHandler(method: string, url: string): Route | null {
    const routes = this.routes[method];
    if (!routes) {
      return null;
    }

    return (
      routes[url] ||
      Object.values(routes).find((route) => {
        const { path, isWildcard } = route;

        if (!isWildcard && !path.includes(':')) {
          return false;
        }

        if (isWildcard || this.#matchPathSegments(path, url)) {
          if (route.paramNames.length > 0) {
            const regexPattern = this.#buildRegexPattern(path, route.paramNames);
            const regex = new RegExp(`^${regexPattern}$`);
            const regexMatches = regex.exec(url);
            if (regexMatches) {
              route.paramValues = regexMatches.slice(1);
            }
          }
          return true;
        }

        return false;
      }) ||
      routes['/*'] ||
      null
    );
  }

  #matchPathSegments(path: string, url: string): boolean {
    const pathSegments = path.split('/');
    const urlSegments = url.split('/');

    if (pathSegments.length !== urlSegments.length) {
      return false;
    }

    for (let i = 0; i < pathSegments.length; i++) {
      const pathSegment = pathSegments[i];
      const urlSegment = urlSegments[i];

      if (pathSegment.startsWith(':')) {
        continue;
      }

      if (pathSegment !== urlSegment) {
        return false;
      }
    }

    return true;
  }

  #buildRegexPattern(path: string, _paramNames: string[]): string {
    let regexPattern = path.replace(/:[^/]+/g, '([^/]+)');
    regexPattern = regexPattern.replace(/\//g, '\\/');

    return regexPattern;
  }

  #extractParamNames(path: string): string[] {
    const paramRegex = /:(\w+)/g;
    const paramMatches = path.match(paramRegex);

    return paramMatches ? paramMatches.map((match) => match.slice(1)) : [];
  }

  #extractParams(route: Route, _url: string): Record<string, string> {
    const { paramNames, paramValues } = route;
    const params: Record<string, string> = {};

    for (let i = 0; i < paramNames.length; i++) {
      params[paramNames[i]] = paramValues![i];
    }

    return params;
  }
}
