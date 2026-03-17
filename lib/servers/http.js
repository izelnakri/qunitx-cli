import http from 'node:http';
// @deno-types="npm:@types/ws"
import WebSocket, { WebSocketServer } from 'ws';
import bindServerToPort from '../setup/bind-server-to-port.js';

/** Map of file extensions to their corresponding MIME type strings. */
export const MIME_TYPES = {
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
  /**
   * Creates and starts a plain `http.createServer` instance on the given port.
   * @returns {Promise<object>}
   */
  static serve(config = { port: 1234 }, handler) {
    const onListen = config.onListen || ((_server) => {});
    const onError = config.onError || ((_error) => {});

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

      server.wss = new WebSocketServer({ server });
      server.wss.on('error', (error) => {
        console.log('# [WebSocketServer] Error:');
        console.trace(error);
      });

      bindServerToPort(server, config);
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
      res.send = (data) => {
        res.setHeader('Content-Type', 'text/plain');
        res.end(data);
      };
      res.json = (data) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(data));
      };

      return this.#handleRequest(req, res);
    });
    this.wss = new WebSocketServer({ server: this._server });
    this.wss.on('error', (error) => {
      console.log('# [WebSocketServer] Error:');
      console.log(error);
    });
  }

  /**
   * Closes the underlying HTTP server.
   * @returns {object}
   */
  close() {
    return this._server.close();
  }

  /** Registers a GET route handler. */
  get(path, handler) {
    this.#registerRouteHandler('GET', path, handler);
  }

  /**
   * Starts listening on the given port (0 = OS-assigned).
   * @returns {Promise<void>}
   */
  listen(port = 0, callback = () => {}) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
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
  publish(data) {
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  /** Registers a POST route handler. */
  post(path, handler) {
    this.#registerRouteHandler('POST', path, handler);
  }

  /** Registers a DELETE route handler. */
  delete(path, handler) {
    this.#registerRouteHandler('DELETE', path, handler);
  }

  /** Registers a PUT route handler. */
  put(path, handler) {
    this.#registerRouteHandler('PUT', path, handler);
  }

  /** Adds a middleware function to the chain. */
  use(middleware) {
    this.middleware.push(middleware);
  }

  #registerRouteHandler(method, path, handler) {
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

  #handleRequest(req, res) {
    const { method, url } = req;
    const urlObj = new URL(url, 'http://localhost');
    const pathname = urlObj.pathname;
    req.path = pathname;
    req.query = Object.fromEntries(urlObj.searchParams);
    const matchingRoute = this.#findRouteHandler(method, pathname);

    if (matchingRoute) {
      req.params = this.#extractParams(matchingRoute, pathname);
      this.#runMiddleware(req, res, matchingRoute.handler);
    } else {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Not found');
    }
  }

  #runMiddleware(req, res, callback) {
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

  #findRouteHandler(method, url) {
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

  #matchPathSegments(path, url) {
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

  #buildRegexPattern(path, _paramNames) {
    let regexPattern = path.replace(/:[^/]+/g, '([^/]+)');
    regexPattern = regexPattern.replace(/\//g, '\\/');

    return regexPattern;
  }

  #extractParamNames(path) {
    const paramRegex = /:(\w+)/g;
    const paramMatches = path.match(paramRegex);

    return paramMatches ? paramMatches.map((match) => match.slice(1)) : [];
  }

  #extractParams(route, _url) {
    const { paramNames, paramValues } = route;
    const params = {};

    for (let i = 0; i < paramNames.length; i++) {
      params[paramNames[i]] = paramValues[i];
    }

    return params;
  }
}
