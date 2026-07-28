# Distributed CRUD — the REST shape on the distributed core

An Express-look web server (`lib/router` — web-standard `Request`/`Response`, so the same app
runs on **Node** via `nodeListen(app, port)` and **Deno** via `Deno.serve(app.fetch)`) in front
of durable entity actors. What each module buys:

| Piece                     | Role                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `router` + middleware     | the stateless HTTP edge — rate limit (429) and a telemetry span per request                 |
| `serve({via})` per row    | ONE owner actor per todo: writes serialize (no row races), reads hit in-memory state        |
| `Store` seam              | persist-before-ack — `memoryStore` here, `postgresStore` in prod (chat example's, verbatim) |
| `rendezvous` + host group | rows spread across entity hosts; gateways stay stateless                                    |
| index actor               | `GET /todos` is one call, not a scan — eventually consistent on create/delete (stated)      |

Scale HTTP by adding gateways, scale data by adding hosts; a dead host's rows rehydrate on a
replacement from the shared store (`distributed-crud-test.ts` proves all three properties over
real HTTP with two gateways).

```
POST   /todos        create (201)          GET /todos       list (via the index actor)
GET    /todos/:id    read  (404 if gone)   PATCH /todos/:id partial update
DELETE /todos/:id    durable delete (204)
```

Bring your own data layer where actors aren't the fit: handlers are plain async functions, so a
direct SQL client or an ORM (e.g. @memoria) drops into any route — or backs the `Store` seam
(`load`/`save`/`clear`) to become the durability layer under the actors themselves.
