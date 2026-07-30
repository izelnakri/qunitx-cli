# Background jobs & supervision

Durable background jobs (Elixir's **Oban**) and a fault-tolerant service tree (OTP's **Supervisor**
and **Horde**), in universal TypeScript. This guide is the map; the API docs live in the source.

## Jobs

```ts
import { Job, memoryStore } from 'qunitx/node';

const jobs = Job.queue({
  store: memoryStore(),
  workers: { 'email.welcome': (args, job, signal) => send(args, { signal }) },
});

await jobs.insert('email.welcome', { to: 'ada@example.com' }); // durable, retried, dead-lettered
```

A **worker** is `(args, job, signal) => …`. Its return is awaited; **throwing marks the attempt
failed**. Declared failures should be `Failure` instances (their `code` is captured for routing);
any other throw is a bug (its stack is captured).

**`insert(worker, args?, opts?)` options** — `queue`, `maxAttempts` (default 3), `scheduleIn`
(ms) / `scheduledAt` (epoch ms), `priority` (0 = most urgent), `unique` (skip if an identical
worker+args+meta job is pending), `meta` (free-form tags).

**A job's lifecycle:**

```
available → executing → (removed on success)
                     ↘ retryable ──(backoff)──→ available → … → discarded  (out of attempts)
scheduled ─(its time)→ available
```

`discarded` jobs are kept as the **dead-letter record** (with their `errors`); everything else is
removed on completion so the queue stays bounded.

**Inspect the queue** — `jobs.peek(id)` (one), `jobs.peekAll({ queue?, state?, worker? })` (a filtered,
copy-safe snapshot for admin/observability), `jobs.cancelJob(id)`, `jobs.pauseQueue`/`resumeQueue`,
`jobs.drain()` (run everything runnable — the test helper).

**Cancelling** — `cancelJob(id)` removes a _pending_ job; for an _executing_ one it aborts the
worker's `AbortSignal` (cooperative — a worker that checks `signal.aborted` stops; one that ignores
it finishes) and ends it terminal, not retried.

**Dead-letter routing** — each `errors[]` entry is `{ attempt, at, error }`, where `error` is always
a live `Failure` (even after a store reload): a thrown `Failure` keeps its `code` + `data`; a raw
throw is coerced to code `'Unknown'` with the original in `.cause`. Route on it:
`jobs.peekAll({ state: 'discarded' }).filter(j => j.errors.at(-1)?.error.code === 'RateLimited')`.

## Fault tolerance — three layers, and what triggers each

The most important thing to understand: **fault tolerance is layered, and only the third layer needs
a supervisor.**

| Failure                           | Handled by                                                                  | Needs config?                                              |
| --------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| a **job** throws                  | retry w/ backoff → `discarded` (dead-letter, with `code`/stack)             | no                                                         |
| a **node dies** mid-job           | the **stager** reclaims it; a survivor re-runs (`SKIP LOCKED`, never twice) | `reclaimAfterMs` — on by default, 60 min (Oban's Lifeline) |
| a **service** crashes _as a unit_ | a **`supervisor`** restarts it — _if it exposes `onExit`_                   | wrap it in a `supervisor`                                  |

A bare `Job.queue(...)` already has layers 1–2 — a failing job is retried, a dead node's work is
reclaimed — **with no supervisor involved.** The supervisor is an _optional_ top layer.

## Stores — pick your durability

| Store                        | Use                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `memoryStore()`              | tests, single process                                                          |
| `fileStore(dir)`             | single node, durable across restarts                                           |
| `raftStore(node, { peers })` | distributed, **no external DB**, **CP leadership** (no clock-skew split-brain) |
| `postgresStore(driver)`      | bring-your-own SQL driver (`postgres`/`pg`/pglite); zero library dependency    |

## Cluster-once work (cron, singletons): `leader()`

Run the same queue on every node against one shared store — the atomic `claim` partitions the work,
no coordination. But **cron** would fire on every node, so pass a `leader`:

```ts
const lead = leader({ store, key: 'jobs:cron', candidate: nodeName });
const jobs = Job.queue({ store, leader: lead, cron: { '0 9 * * *': { worker: 'report.daily' } } });
```

On a `raftStore`, `leader()` uses **CP** leadership (terms + quorum — no split-brain); elsewhere a
TTL lease. A leadership _gate_ is never exactly-once on its own — for irreversible effects (charging
a card), pair it with an idempotency key. Give a schedule a **list** of entries to run several
workers on one expression; cron-inserted jobs carry `meta: { cron: expr }`.

## Supervision — when to use which

Two supervisors, two shapes — they **compose**, they don't compete:

- **`supervisor`** — your app's **skeleton**: a small, fixed, ordered, interdependent set of named
  services on _one node_ (`store → jobs → web`). Boot order, reverse shutdown, restart strategies,
  `get`-wired dependencies.
- **`distributedSupervisor`** — a large, dynamic, independent **keyspace across the cluster** (an
  actor per room/cart/device). Placement by rendezvous, re-homed on node death.

```ts
const app = supervisor(
  [
    { name: 'store', start: () => fileStore('./data') },
    {
      name: 'jobs',
      start: (get) => Job.queue({ store: get('store'), workers }),
      restart: 'permanent',
    },
    { name: 'web', start: (get) => serveHttp({ jobs: get('jobs') }) },
  ],
  { strategy: 'rest_for_one' }, // store restarts → jobs and web restart after it, in order
);
await app.start();
app.get('jobs').insert('email.welcome', { to }); // name lookup — restart-safe
```

**Restart types** (per child): `permanent` (always — a service that must stay up), `transient`
(only on a crash — a task that should finish once but retry on failure), `temporary` (never).

**Strategies** (per supervisor): `one_for_one` (only the crashed child), `rest_for_one` (it + those
started after it — dependents), `one_for_all` (all — a tightly-coupled set).

**Restart intensity** — more than `maxRestarts` (3) within `maxSeconds` (5) shuts the tree down
instead of crash-looping forever (OTP's `max_restarts`).

**Distributed + in-place** — `distributedSupervisor` survives _node_ death automatically (roster
liveness); wiring the child's `onExit` also restarts it _in place_ on a live node. Compose: a
`distributedSupervisor` child is often a local `supervisor` subtree — distributed decides _which
node_ hosts a key and survives node loss; local decides _what it's made of_ and restarts its parts.

## Building a supervisable service

A supervised value exposes:

- **`stop()`** — graceful teardown. It must **not** trigger `onExit`.
- **`onExit(handler)`** — _if the service can die as a unit_: store the handler, and call it with a
  reason on **abnormal** death, so the supervisor can restart it.

```ts
function wsClient(url: string) {
  let crashed: (reason?: unknown) => void = () => {};
  let graceful = false;
  const socket = new WebSocket(url);
  socket.addEventListener('close', (e) => {
    if (!graceful) crashed(new Error(`closed ${e.code}`));
  });
  return {
    send: (m: string) => socket.send(m),
    onExit: (h) => {
      crashed = h;
    }, // the supervisor subscribes here
    stop: () => {
      graceful = true;
      socket.close();
    }, // graceful — does NOT fire crashed
  };
}
```

Omit `onExit` only for a service that **self-heals** (a `Job.queue` retries its own jobs) or can't
crash as a unit — then use `restart: 'temporary'`. `Job.queue` _does_ expose `onExit` for the rare
catastrophic scheduler failure, so it can be supervised without the warning.

**The one rule that keeps restart honest** (this is a real JS limit, not OTP's): a service's state
must be **durable (in a Store) or private to the service** — never shared mutable memory across
siblings. A supervisor restarts a _service_; it cannot heal a shared object another child corrupted.
And no library can preempt a child stuck in a tight loop on a single-threaded runtime — chunk long
work with `await`.
