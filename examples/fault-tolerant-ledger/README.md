# Fault-tolerant ledger — an architecture example

A small, realistic payments API built on this library's OTP-shaped primitives (`Task`,
`Failure`, `Stream`, `Supervisor`, `Node`), designed to show **one thing clearly**: how to
decide what runs where, so your web app stays up when parts of it fail. No web framework — just
`node:http`, the library, and `postgres` for the database.

The single decision this example teaches:

> **Divide by the event loop first, then by the pod — and only when a rule below forces you to.**

Everything else here is in service of making that decision concrete.

---

## 1. What the app does

A ledger of payment transactions. Five routes, deliberately spanning every workload class:

| Route                      | Workload            | Where it runs   | Why                                          |
| -------------------------- | ------------------- | --------------- | -------------------------------------------- |
| `GET /health`              | trivial, local      | API loop        | liveness — "is the process alive?"           |
| `GET /ready`               | one DB ping         | API loop        | readiness — "can we serve?"                  |
| `POST /transactions`       | **I/O** (DB write)  | API loop        | awaits the DB; yields; cheap                 |
| `GET /transactions/:id`    | **I/O** (DB read)   | API loop        | same                                         |
| `GET /transactions/export` | **I/O**, streamed   | API loop        | DB cursor → `ReadableStream`, flat memory    |
| `POST /reports/monthly`    | **CPU** (aggregate) | **report node** | would freeze the API loop — must be isolated |

Four of five routes are I/O-bound and cooperative, so they share one event loop happily. The
fifth is CPU-bound, and that single difference drives the entire architecture.

---

## 2. The map of the code

```
src/
  failures.ts        the declared failure vocabulary + the ONE failure→HTTP-status map
  config.ts          env config — and the one switch that picks Topology A vs B
  db.ts              the database ADAPTER: raw driver throws classified into Failures here, nowhere else
  http.ts            a tiny express-like router over node:http; the single Reply write-point
  report-behavior.ts the CPU-bound unit, as a genServer()able Behavior (runs on ITS node's thread)
  report-worker.ts   the report NODE entry — a Worker thread (A) or a standalone process (B)
  api-node.ts        the API process: HTTP server + the supervision tree + the topology switch
k8s/
  topology-b.yaml    Deployments/Service/HPA/PDB for the separate-pods topology
```

Read them in that order; each depends only on the ones above it.

---

## 3. The core decision — when do I split a workload out?

Three tiers, applied in order. **Do not skip to tier 3.** Most apps are tier 1 and should stay
there.

### Tier 1 — In-realm, one event loop (the default)

If a unit of work is **I/O-bound and cooperative** — it spends its time `await`ing a database,
an upstream HTTP call, a queue — it belongs on the API's event loop with everything else. It
yields at every `await`, so hundreds of concurrent such requests interleave perfectly on one
thread. `POST /transactions`, `GET /transactions/:id`, the streamed export: all tier 1.

**Do not over-split tier 1.** A "transaction-writer actor" and an "HTTP handler" on the same
loop is not more fault-tolerant than a plain function call — it is more moving parts for the
same physics. Reach for separate nodes only when a rule below forces you to.

### Tier 2 — Its own THREAD (a Worker), when work is CPU-bound

**The rule, and it is not negotiable:** if a handler can run **more than ~10ms of synchronous
CPU** (a big `JSON.parse`, a `crypto` sync call, an aggregation, image/PDF work, a regex on
untrusted input), it must not share the API's event loop. JavaScript has no preemptive
scheduler: one such handler freezes _every_ request, _and_ the supervised heartbeat, _and_ the
supervisor itself, because they all live on that one thread. (Run `node preemption-demo.mjs`
in this folder — one CPU-bound handler made a hello-world request take 2001ms and starved a 100ms
timer completely.)

So `POST /reports/monthly`'s aggregation lives in `report-behavior.ts` and runs on a **separate
thread** — a report node. The API delegates with `api.call('group:reports', ...)`; the chosen
worker **streams its own DB cursor and folds incrementally** (nothing buffers on either side —
an earlier version shipped the rows through the payload, an OOM waiting to happen), all on the
worker's thread. The API loop only awaits. **This is the mitigation for the one thing BEAM has
that we don't: the process — not the in-realm supervisor — is the CPU fault domain.**

Three details make the pool robust, each with an existing primitive:

- **A POOL, not one worker.** The workers form the `reports` process group; `call('group:reports')`
  round-robins them, so N threads give N-core report parallelism and one slow report never
  head-of-line-blocks the next. (One named worker would just relocate the blocking to its mailbox.)
- **Group membership is the liveness signal.** A worker `join`s on start; a crash makes its node
  leave (nodedown), which the API sees immediately — no separate heartbeat needed. Readiness =
  `groupMembers('reports').length > 0`.
- **Fail-fast.** The report route checks readiness at request time and returns `ReportUnavailable`
  → `503` _immediately_ when the pool is empty, instead of waiting the full call timeout. And each
  worker's `genServer(..., { maxMailbox: 64 })` sheds under overload rather than growing unboundedly.

The signal you're in tier 2: you catch yourself thinking "this endpoint is sometimes slow for
no I/O reason," or a p99 spike correlates with a particular input size. That's loop starvation.

### Tier 3 — Its own PROCESS / pod, when isolation must outlive the thread

A Worker thread isolates CPU but still **shares the process heap and lifecycle**. Promote a
Worker node to a _separate process/pod_ only when you need one of:

1. **Independent scaling.** Reports are heavy and bursty; requests are steady. You want 3 API
   pods and 12 report pods, scaled on different signals. (Topology B's HPA scales reports on CPU,
   independent of the API's replica count.)
2. **Independent failure / memory isolation.** A report that OOMs must not take down a pod that
   is _also_ serving `/transactions`. Separate pods = separate OOM killers = a report crash-loop
   never touches request-serving.
3. **Independent deploy cadence.** The report code changes ten times a day and the API is
   frozen for audit — or vice versa. Separate images, separate rollouts.
4. **The work is already remote** — a different team's service, a different language, a GPU box.

If none of these is true, **stay in Topology A** (Worker thread, one pod). More pods is more
network, more failure surface, and a hub to run. Split because a rule forced you, not for
symmetry.

---

## 4. The two topologies, and the one-line switch

Both run the _same code_; `config.ts` picks based on `REPORTS_HUB_URL`:

**Topology A — single pod (default).** The report node is a `worker_threads` Worker inside the
API process (`Node.fromPort`). CPU isolation, no hub, one Deployment. Start here.

```
API process ── worker_threads ──> report Worker (own thread)
       │  (fromPort, point-to-point)
```

**Topology B — separate pods.** Set `REPORTS_HUB_URL=ws://ledger-hub:4369`. The report node is a
separate `node src/report-worker.ts` process/Deployment; both dial the hub (`Node.wsTransport`).
This is `k8s/topology-b.yaml`. Adopt it when a tier-3 rule applies.

```
API pods ──┐                 ┌── report pods
           ├──> ledger-hub <─┤    (own process, own OOM, own HPA)
API pods ──┘   (epmd + mesh) └── report pods
```

The whole point: **going from A to B is a config value and a Deployment, not a rewrite.** The
API's `call('reports@worker', ...)` is identical either way — location transparency.

---

## 5. How library fault-tolerance maps to Kubernetes

This is where "99.99% uptime" actually comes from: **most faults heal below the orchestrator,
and k8s only handles whole-process death.** The two layers, and who owns what:

| Fault                                  | Handled by                                                                         | Pod restart?      |
| -------------------------------------- | ---------------------------------------------------------------------------------- | ----------------- |
| The reaper loop throws                 | in-realm `Supervisor` (restarts it in place)                                       | **no**            |
| The report node crashes (Topology A)   | in-realm `Supervisor` restarts the Worker                                          | **no**            |
| The report node is briefly unreachable | supervised `heartbeat` → readiness `false` → LB pulls the pod; recovers on its own | **no**            |
| The DB blips                           | `/ready` returns 503 → LB pulls the pod; back in when DB returns                   | **no**            |
| The report pod OOMs (Topology B)       | k8s restarts _that_ Deployment's pod                                               | reports only      |
| The API process dies / deadlocks       | `livenessProbe` on `/health` fails → k8s restarts                                  | **yes, this pod** |

The discipline behind the two probes — the single most important k8s detail here:

- **`livenessProbe` → `/health`**: "is the process alive?" Local, cheap, no dependencies. If it
  fails, k8s **restarts the pod**. Never put a dependency check here — a DB blip must not
  restart-loop every pod in your fleet.
- **`readinessProbe` → `/ready`**: "can we serve _right now_?" Checks the DB and the report node.
  If it fails, k8s **pulls the pod from the load balancer but does not restart it** — it may
  recover (the DB returns, the report node comes back), and the supervised heartbeat re-arms
  readiness automatically. This is what lets a degraded pod stay alive and self-heal instead of
  crash-looping.

The rest of the k8s contract, each tied to a piece of code:

- **Graceful shutdown**: k8s sends `SIGTERM` then waits `terminationGracePeriodSeconds`. The
  `SIGTERM` handler in `api-node.ts` stops accepting, drains in-flight requests, then tears down
  the supervision tree and DB — zero dropped requests on a rollout.
- **`PodDisruptionBudget`**: keeps a quorum of API pods serving during node drains/rollouts.
- **HPA**: scales the report Deployment on CPU (Topology B) — the concrete payoff of tier 3.
- **Hot code upgrades vs rolling restart**: an _application-behavior_ change (new report logic,
  same runtime) can hot-swap live via `sys.upgrade` with zero dropped requests — see
  `docs/hot-code-upgrades.md`. A _runtime_ change (Node version, native dep) is a rolling
  restart behind the readiness probe. Use the cheap tool for the common case.
- **The hub is the remaining single point** (like Erlang's epmd): run two hub replicas and have
  nodes dial both, or accept a brief reconnect window — the transport already redials with
  backoff and re-hellos automatically.

---

## 6. Why the failure vocabulary is load-bearing here, not decoration

Every temporary fault in this app — DB down, report node wedged, call timed out — surfaces as a
**declared** `Failure` with a `503`, never a `500`. That distinction is the whole operational
contract with k8s and clients: a `503` means _retry / I'll be back_; a `500` means _a bug
shipped_. Because `db.ts` classifies at the driver boundary and `call().mapErr(...)` classifies
the transport boundary, a genuine bug (a `TypeError` in a handler) is the _only_ thing that
reaches the crash boundary and returns `500` — so your `500` rate is a real bug signal, not
noise from every transient blip. Readiness, alerting, and retry policies all hang off that clean
two-tier split.

---

## 7. Running it

```bash
# schema
psql "$DATABASE_URL" -c 'CREATE TABLE transactions (
  id uuid PRIMARY KEY, amount_cents bigint NOT NULL,
  currency text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());'

# Topology A (Worker thread, one process) — the default
DATABASE_URL=postgres://localhost/ledger node src/api-node.ts

# Topology B (separate report process) — three terminals
node -e "import('../../lib/node/hub.ts').then(m => m.startHub({ port: 4369 }))"
REPORTS_HUB_URL=ws://localhost:4369 node src/report-worker.ts
REPORTS_HUB_URL=ws://localhost:4369 DATABASE_URL=... node src/api-node.ts

curl -XPOST localhost:8080/transactions -d '{"amount_cents":500,"currency":"USD"}'
curl localhost:8080/transactions/export        # streamed NDJSON
curl -XPOST 'localhost:8080/reports/monthly?month=2026-07'   # delegated to the report node
```

> Runs on Node 24 (native TS) and Deno. `postgres` is the one external dependency; `ws` (the
> hub, Topology B) already ships with the library. In a real project the imports would be the
> published package name instead of `../../../lib/...`.
