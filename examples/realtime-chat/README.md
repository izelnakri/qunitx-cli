# Realtime chat — the stateful-entity pattern

Where the ledger example was **stateless** (every request independent, actors only for
background work), this one is **stateful per entity**: a chat room is a live thing with member
state and history, and messages must route to _the one_ actor that owns it. That is the half of
OTP the ledger doesn't touch, and it needs exactly two building blocks — **`DynamicSupervisor`**
(spawn a supervised process on demand) and **`Registry`** (find the process for a key). This
example is the smallest honest demonstration of the pair. Run it:

```bash
node src/demo.ts   # two hosts + two gateways in one process, over an in-process hub
```

## 1. The shape

| Node role                               | What it is                   | Holds                                                               |
| --------------------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| **room host** (`room-host.ts`)          | where rooms live             | a `DynamicSupervisor` of room actors + their `Registry` entries     |
| **room actor** (`room-behavior.ts`)     | one `serve()`d unit per room | `{ members, recent }`, mutated one message at a time by its mailbox |
| **gateway** (a browser/websocket front) | where users connect          | nothing — it routes to rooms it doesn't host                        |

A room is a **stateful actor**: its mailbox serializes every join/leave/message, so its member
set and history change one event at a time — no locks, no races (gen_server state). One room =
one supervised process, spawned on demand, addressable by key. This is the Phoenix Channels
shape in this library's primitives.

## 2. The one pattern to learn: find-or-start

The whole example turns on how a gateway reaches a room it may not have started yet
(`chat-client.ts`):

```
join("lobby"):
  owner = whereis("rooms", "lobby")          # HOT path: the Registry knows → done
  if not owner:                              # COLD path: the room doesn't exist yet
    host = hosts[ hash("lobby") % hosts ]    # deterministic → all callers pick the SAME host
    call(host, "host.ensureRoom", {lobby})   # that host DynamicSupervisor.start_child's it
                                             #   and Registry.register's the key
    wait for whereis("rooms","lobby")         # the registration gossips to every node
  call("via:rooms/lobby", ...)               # route to THE owner, wherever it lives
```

Two design choices make this correct and simple:

- **`Registry` gives single-owner routing.** A room is served with `serve(..., { via: { registry:
'rooms', key } })` — Elixir's `{:via, Registry, {Reg, key}}`: the unit registers itself and
  `call('via:rooms/lobby', ...)` routes to the _one_ owner. Unlike a process **group** (`group:`),
  which round-robins _many_ members — groups are for services (any worker will do), the Registry
  is for entities (there is exactly one #lobby). If two hosts race the same key during a
  partition, the loser's unit **self-terminates** and everyone converges on the survivor.
- **A deterministic hash makes cold-start race-free without a lock.** Every gateway hashes
  `"lobby"` to the _same_ host, so two users creating #lobby simultaneously both hit one host,
  whose local `start_child` check serializes them. No distributed coordination, no double room.
  Once started, the `Registry` publishes the owner and the hash path is never taken again.

`DynamicSupervisor` + `Registry` are the pair: the supervisor _starts and keeps alive_ the room
process; the registry _finds_ it by key. Elixir builds stateful systems this way (Registry +
DynamicSupervisor is the textbook combination); this is the same, on web-standard transports.

## 3. Lifecycle — spawn and reap

- **Spawn on demand**: the first `join` for a key `start_child`s the room (`restart: 'transient'`)
  and registers it. A room that _crashes_ is restarted fresh under the same key (transient); a
  room that _exits cleanly_ is not.
- **Reap when empty**: when the last member `leave`s, the gateway casts `host.closeRoom`, which
  `terminate_child`s the room (a clean exit → no restart) and `unregister`s the key. Rooms cost
  nothing when idle. (`demo.ts` shows `whereis` going `null` after the room empties.)

## 4. Durability — how state survives a host dying, and minimal churn

The two hard problems of distributed stateful systems, both closed here (the demo proves the
first end-to-end):

### State survives host death — persist-before-ack + rehydrate-on-access

Each room is served **with a `store`** (`serve(..., { store, storeKey })`), so:

- **Persist-before-ack**: every mutating message (join/leave/say) writes the new state durably
  _before_ the caller is acked. A "sent" message is on disk before the sender hears "ok" — there
  is no periodic-snapshot window to lose deltas in. (Reads use `persist: false`.)
- **Rehydrate-on-access**: when a room's host dies, the `Registry` prunes it and rendezvous
  hashing re-selects a survivor; the next `join` re-creates the room _there_, and `serve`'s
  restore loads its members and history from the **shared store**. Availability _and_ state are
  preserved.

`demo.ts` shows exactly this: chat in #lobby, kill its host, reconnect → the room comes back on a
**different** host with its history intact. The store in the demo is one `memoryStore()` shared
by both hosts (simulating a shared DB); in production it is `postgresStore(DATABASE_URL)`
(`store-postgres.ts`) — a shared Postgres, so durability survives real process/pod death, not
just an in-process restart. The code is identical; only the store backend changes.

### Minimal churn on scale events — rendezvous (HRW) hashing

Cold-start routing uses `rendezvous(key, hosts)`, not `hash(key) % hosts.length`. Adding or
removing a host relocates only **~1/N** of rooms (the ones that scored highest for the changed
host) instead of reshuffling the whole keyspace. A live room keeps serving from its `Registry`
entry regardless; only _future_ cold-starts of relocated keys pick the new owner, and they
rehydrate from the store.

### Hardenings, and the Elixir/Horde API alignment

The distributed layer is hardened against the failure modes a stateful cluster actually hits,
with APIs aligned to Elixir/Horde where they touch the developer surface:

| Concern              | Here                                                         | Elixir/Horde analogue                   | Divergence & mitigation                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| entity registration  | `serve(..., { via: { registry, key } })`                     | `{:via, Registry, {Reg, key}}`          | ours is **optimistic-AP** (can't be synchronous under gossip lag like Elixir's _local_ Registry); on a race the loser self-terminates and callers re-resolve via `whereis` — Horde.Registry's behaviour |
| single-owner routing | `call('via:reg/key', ...)`                                   | `GenServer.call({:via, ...})`           | same shape                                                                                                                                                                                              |
| pool routing         | `call('group:svc', ...)`                                     | `:pg` round-robin                       | same shape                                                                                                                                                                                              |
| find-or-start        | rendezvous hash → one host → local `start_child`             | Horde.DynamicSupervisor + registry      | deterministic host pick makes cold-start race-free without a distributed lock                                                                                                                           |
| minimal churn        | `rendezvous(key, hosts)`                                     | Horde's consistent hashing              | HRW moves ~1/N keys on churn, no virtual nodes                                                                                                                                                          |
| dead/zombie owner    | automatic **net-tick** evicts a wedged host; Registry prunes | Erlang `net_ticktime` + `:global` prune | catches app-level wedges the socket can't see                                                                                                                                                           |
| call-plane scale     | point-to-point hub routing                                   | Erlang's point-to-point mesh            | our hub is a relay, not a mesh; directed frames route point-to-point, gossip still broadcasts                                                                                                           |
| registry convergence | delta-state **CRDT** (ORSWOT) + periodic **anti-entropy**    | Horde's `DeltaCrdt` registry            | a dropped `join`/`register` and a healed partition both self-heal; a per-op delta carries only its own dots (dot-cloud causal context) so it can't poison a peer that missed an earlier op              |
| redistribution       | `drain()` on scale-down + `monitorNodes` rebalance on scale-up | `Horde.DynamicSupervisor` on any membership change | symmetric: a leaving host hands rooms to their successor, a joining host pulls its rendezvous share — both re-home BY KEY and rehydrate from the shared store (persist-before-ack made state durable), not a live process-state stream |
| node up/down         | `monitorNodes` (nodeup + nodedown)                           | `:net_kernel.monitor_nodes(true)`       | `monitor` alone was down-only; the up half is what drives scale-up rebalancing                                                                                                                          |
| overload protection  | `circuitBreaker({ maxFailures, resetTimeoutMs })`            | Erlang `:fuse` / Akka `CircuitBreaker`  | closed→open→half-open; guards a `call` to a flaky peer, fast-fails with a declared `CircuitOpen` while open, probes once after cooldown                                                                  |
| cluster formation    | `cluster({ strategy, connect })` — polling discovery         | Elixir `libcluster` (`Strategy.poll`)   | the strategy (env/DNS/K8s) stays platform-specific; the diff/connect loop is universal, so a node auto-forms the mesh instead of a hardcoded peer list                                                   |
| load throttling      | `rateLimiter({ capacity, refillPerSec })` (token bucket)     | Erlang `:jobs` token bucket             | the throttle leg of load protection alongside GenStage backpressure and the circuit breaker — admit a burst + sustained rate, reject the rest                                                            |
| instrumentation      | `Telemetry.execute` / `attach` / `span`                      | Elixir `:telemetry`                      | the standard decoupled metrics/tracing bus — emit named events with measurements, attach sinks separately; `span` brackets an op with start/stop/exception + duration                                    |

### What's built now — and the one honest frontier that remains

The two gaps an earlier draft left open are closed:

1. **Convergent membership/registry.** `join`/`register` are facts in an OR-Set CRDT: a per-op
   delta broadcasts for immediacy, and a round-robin **anti-entropy** pull is the backstop, so a
   dropped update or a partition split-and-heal converges to one owner (proven in
   `test/node/chaos-test.ts` under 40% frame loss). Liveness is tracked separately from
   registrations, so a false nodedown only _hides_ a peer's entries — it never loses them.
2. **Symmetric redistribution.** `drain()` proactively re-homes rooms to their successor before a
   host leaves, so the next caller sees no cold start; and `monitorNodes` (Erlang `nodeup`) drives
   the other half — a joining host pulls its rendezvous share of existing rooms, so the keyspace
   re-spreads as the cluster grows. HRW moves only ~1/N of each host's rooms per membership change
   (`realtime-chat-handoff-test.ts`).

The remaining frontier is **partitioning the registry itself**. Like Horde, ours is _fully
replicated_ — every node holds every entry, and anti-entropy is O(entries) per sync. That scales
to a large cluster but not to a billion-key registry; true horizontal scale needs a **sharded**
registry (a DHT / hash ring), which neither Elixir's `Registry` nor Horde does. That is the honest
boundary now: routing, supervision, durability, split-brain healing, zombie eviction, CRDT
convergence, symmetric redistribution (scale-up + scale-down), overload protection (circuit
breaker + rate limiter), cluster auto-formation, and telemetry are here; a **sharded** registry
(a DHT/ring) and **CP consensus** (Raft) are the two research-grade pieces left — both beyond what
Elixir's `Registry` or Horde itself does.
