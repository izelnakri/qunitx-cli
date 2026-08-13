// Barrel for the Node leg: import * as Node from '.../lib/node/index.ts'.
// Elixir's Node module, JS-shaped: Node.start(name, transport), Node.memoryHub(), Node.fromPort(worker).
// (`Node.start` also ships as a named `Node` namespace for `import { Node }` callers.) Message passing
// (call/cast/handle) replaces remote spawns — JS cannot ship closures — and the Failure envelope codec
// keeps channel identity across every hop: declared failures arrive declared, never clone-gutted.
export {
  Node,
  start,
  heartbeat,
  memoryHub,
  fromPort,
  type Frame,
  type Trace,
  type Transport,
  type NodeHandle,
} from './node.ts';

// The socket wire: universal (native WebSocket). The default codec is binary — tagged,
// length-prefixed, ETF-in-spirit (Erlang never base64s its distribution); jsonCodec is the
// devtools-readable reference. The relay hub lives in ./hub.ts, deliberately OUTSIDE this
// barrel: it stands on the `ws` package, and the barrel stays browser-safe.
export { wsTransport, traceTransport, binaryCodec, jsonCodec, type Codec } from './ws.ts';

// Cluster-join auth — Erlang's magic cookie via HMAC challenge-response (cookie never on the wire).
// Used by wsTransport's/startHub's `secret`; exported so custom transports/relays can reuse it.
export { authDigest, randomNonce, safeEqual } from './auth.ts';

// Observability sink: a Prometheus-format exporter over the node's telemetry events (call counts,
// error rate, latency histogram) — serve `.prometheus()` from a /metrics route.
export { collectMetrics, type Metrics, type MetricsSnapshot } from './metrics.ts';

// Event sourcing over a Store — Commanded/EventStore's model: persist the append-only event log,
// fold it to state, replay on restart. The log is the source of truth; snapshots bound replay.
export { eventSourced, type Aggregate, type EventSourced } from './event-sourced.ts';

// Rolling cluster upgrade over the `<unit>.sys.upgrade` relup subject — drive a new version across
// the fleet a batch at a time, verifying each and halting at the canary if a build goes bad.
export { rollingUpgrade, type RollingUpgradeReport } from './rolling-upgrade.ts';

// Rendezvous (HRW) hashing: pick THE owner of a key with minimal reshuffling on membership
// change — the routing primitive for distributed stateful entities (see examples/realtime-chat).
export { rendezvous } from './rendezvous.ts';

// Circuit breaker (Erlang :fuse / Akka): fail fast past a flaky peer and let it recover.
export { circuitBreaker, type CircuitBreaker, type CircuitState } from './circuit-breaker.ts';

// Token-bucket rate limiter: throttle work to a sustained rate + burst — the third load-protection
// leg alongside GenStage backpressure and the circuit breaker.
export { rateLimiter, type RateLimiter } from './rate-limiter.ts';

// Automatic cluster formation (Elixir libcluster): a polling strategy discovers peers and the
// manager diffs it against the connected set to converge the topology.
export { cluster, type Cluster } from './cluster.ts';

// Mesh transport: talk peer-to-peer instead of through the relay hub — retires the hub SPOF.
// Universal routing core over an injected per-peer link factory; meshNetwork is the in-process test rig.
export { meshTransport, meshNetwork, webSocketMeshLink, type MeshLink } from './mesh.ts';

// The PARTITIONED registry (frontier #1): each key lives on one rendezvous-chosen coordinator,
// so memory/sync scale with the cluster (beyond Horde's fully-replicated design) — and claims
// serialize through the coordinator, restoring Elixir's synchronous duplicate rejection.
export { shardedRegistry, type ShardedRegistry, type ClaimResult } from './sharded-registry.ts';

// Convergent counters + LWW register map — riak_dt's emcntr/LWW family, for distributed
// metrics, gauges, and settings that merge without coordination.
export {
  GCounter,
  PNCounter,
  LWWMap,
  type GCounterState,
  type PNCounterState,
  type LWWEntry,
  type LWWMapState,
} from './counters.ts';

// The delta-state OR-Set: the CRDT that makes membership/registry converge under frame loss
// and partition heal (anti-entropy), the way Horde's registry does.
export { ORSet, type Dot, type VersionVector, type CausalContext, type CrdtState } from './crdt.ts';

// Hot code upgrades: Erlang's release mechanics on web standards — import() as the code
// server, run-to-completion as suspend/resume, codeChange as code_change/3, and the
// `<name>.sys.upgrade` subject as the relup that reaches remote nodes.
export { memoryStore, type Store } from './store.ts';
export {
  genServer,
  spawnProcess,
  superviseGenServer,
  type Behavior,
  type GenServer,
  type GenServerOptions,
  type Pid,
  type Self,
  type TimerRef,
} from './gen-server.ts';

// Elixir's Process module — the static side: Process.spawn (anonymous units) + free-function
// link/exit/alive/whereis. Per-unit ops live on the handle and the `self` a handler gets.
export { Process, type BoundProcess } from './process.ts';

// The cooperative scheduler — BEAM's reduction-budget fairness on a single-threaded loop. The
// mailbox pump spends a reduction per message and yields its slice here; `Process.yield` is the
// in-handler form. Exposed so other runtimes can reuse the yield/priority primitives directly.
export { yieldToLoop, yieldWith, type Priority } from './scheduler.ts';

// Typed RPC sugar: a compile-time contract + a stable string name give closure-like call sites
// (`ledger.debit(arg)`) over call/handle, with no code on the wire. See service.ts for the model.
export {
  defineService,
  type ServiceApi,
  type Schema as ServiceSchema,
  type Impl as ServiceImpl,
  type Client as ServiceClient,
  type Caster as ServiceCaster,
} from './service.ts';
export {
  supervisor,
  type Supervisor,
  type ChildSpec,
  type Service,
  type Strategy,
  type Restart,
} from './supervisor.ts';
export { distributedSupervisor, type DistributedSupervisor } from './distributed-supervisor.ts';
