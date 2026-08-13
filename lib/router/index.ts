// Barrel for the Router leg: import { router, json } from '.../lib/router/index.ts'.
//
// The HTTP edge, Express-shaped on web standards: app.get('/todos/:id', h), middleware, params —
// but handlers take a standard Request and return a standard Response, so one app serves every
// runtime: Deno.serve(app.fetch), nodeListen(app, port) (./node.ts, deliberately OUTSIDE this
// barrel — it stands on node:http), or app.fetch(new Request(...)) directly in tests. The
// Plug/Router role: the stateless edge in front of the distributed core.
export { router, json, type Router, type Handler, type RouteRequest } from './router.ts';
