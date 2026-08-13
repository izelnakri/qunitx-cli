// Elixir's **Supervisor** + **Application**: a named tree of services started in order, stopped in
// reverse, and restarted on abnormal exit per a strategy. It is universal (no node: APIs) — a child
// is any value with an optional `stop()`, and, to be auto-restarted, an `onExit(handler)` seam it
// calls when it dies abnormally (a graceful `stop()` must NOT fire it). Store-backed services
// (Job.queue) restart cleanly because their state is durable — the new instance re-reads it, exactly
// OTP's "rebuild from persisted state". Address children through {@link Supervisor.get} (not a
// captured reference) so a lookup always resolves the CURRENT instance after a restart.
//
// WHEN TO USE which supervisor:
//   • `supervisor` (this) — your APP'S SKELETON: a small, fixed, ORDERED, interdependent set of
//     named services on ONE node (store → jobs → web), with restart strategies and `get`-wired
//     dependencies. Boot order, reverse shutdown, one_for_one/rest_for_one/one_for_all.
//   • distributedSupervisor — a large, DYNAMIC, INDEPENDENT keyspace spread ACROSS a cluster (10k
//     rooms, one per key), placed by rendezvous and re-homed on node death. No order, no strategies
//     — placement + failover.
//   They COMPOSE: a distributedSupervisor child is often itself a local `supervisor` subtree —
//     distributed decides WHICH NODE hosts a key (and survives node loss); local decides what it is
//     MADE OF, in what order, and restarts its parts in place. (Elixir: OTP `Supervisor` nested
//     under `Horde.DynamicSupervisor`.)
//
// BUILDING A SUPERVISABLE SERVICE: expose `stop()` (graceful teardown — it must NOT trigger
// `onExit`), and, IF the service can die as a unit, `onExit(handler)` — store the handler and call
// it with a reason on abnormal death so the supervisor can restart it. Omit `onExit` only for a
// service that self-heals (a Job.queue retries its own jobs) or can't crash as a unit — then use
// `restart: 'temporary'`. Keep each service's state durable (a Store) or private — never shared
// mutable memory across siblings, which a restart cannot heal.

/** OTP restart type: `permanent` always restarts, `transient` only on abnormal exit, `temporary`
 *  never. Default `permanent`. */
export type Restart = 'permanent' | 'transient' | 'temporary';

/** A supervised value. `stop` is graceful teardown; `onExit` (optional) lets the child report an
 *  ABNORMAL exit so the supervisor can restart it — a graceful `stop()` must not trigger it. */
export interface Service {
  /** Graceful teardown — must NOT trigger `onExit`. */
  stop?(): void | Promise<void>;
  /** Report an ABNORMAL exit so the supervisor can restart the child. */
  onExit?(handler: (reason?: unknown) => void): void;
}

/** How siblings are restarted when one dies — Elixir's supervision strategies. */
export type Strategy = 'one_for_one' | 'rest_for_one' | 'one_for_all';

/** One child: a `name`, a `start` (given a `get` to look up already-started siblings), and an
 *  optional {@link Restart} policy. */
export interface ChildSpec<S = unknown> {
  /** Unique name — used for `get` lookups and restart identity. */
  name: string;
  /** Boot the child; `get` looks up already-started siblings for dependency wiring. */
  start: (get: <T = unknown>(name: string) => T) => S | Promise<S>;
  /** When to restart it (default `permanent`) — see {@link Restart}. */
  restart?: Restart;
}

/** A running supervision tree — see {@link supervisor}. */
export interface Supervisor {
  /** Start every child in spec order (each `start` can `get` earlier siblings). */
  start(): Promise<void>;
  /** The CURRENT instance of a named child (resolves the live one after any restart). */
  get<T = unknown>(name: string): T;
  /** Restart a child by name now, applying the strategy — the manual twin of an `onExit`. */
  restartChild(name: string): Promise<void>;
  /** Stop every child in REVERSE order — graceful, ordered shutdown. */
  stop(): Promise<void>;
}

/**
 * Build a {@link Supervisor}. Children start in order and stop in reverse; a child that reports an
 * abnormal exit (via its `onExit` seam) is restarted per `strategy` (default `one_for_one`).
 *
 * ```ts
 * const log: string[] = [];
 * const app = supervisor([
 *   { name: 'store', start: () => ({ tag: 'store', stop: () => void log.push('stop store') }) },
 *   { name: 'jobs', start: (get) => ({ store: (get('store') as { tag: string }).tag }) },
 * ]);
 * await app.start();
 * (app.get('jobs') as { store: string }).store; // 'store' — looked up at boot
 * await app.stop();
 * log; // ['stop store']
 * ```
 */
export function supervisor(
  specs: ChildSpec[],
  options: {
    strategy?: Strategy;
    warn?: (message: string) => void;
    /** OTP restart intensity: if children restart more than `maxRestarts` times within
     *  `maxSeconds`, the supervisor gives up and shuts down — crash-loop protection. Defaults 3/5. */
    maxRestarts?: number;
    maxSeconds?: number;
    /** Called when restart intensity is exceeded (OTP escalates to the parent supervisor). */
    onShutdown?: (reason: string) => void;
    now?: () => number;
  } = {},
): Supervisor {
  const strategy = options.strategy ?? 'one_for_one';
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const maxRestarts = options.maxRestarts ?? 3;
  const maxSeconds = options.maxSeconds ?? 5;
  const now = options.now ?? (() => Date.now());
  const order = specs.map((spec) => spec.name);
  const specOf = new Map(specs.map((spec) => [spec.name, spec]));
  const services = new Map<string, unknown>();
  const restartTimes: number[] = []; // sliding window for restart-intensity (OTP max_restarts)
  let started = false;

  const get = <T>(name: string): T => {
    if (!services.has(name)) throw new Error(`supervisor: no started child named '${name}'`);
    return services.get(name) as T;
  };

  const startChild = async (spec: ChildSpec): Promise<void> => {
    const service = await spec.start(get);
    services.set(spec.name, service);
    // Auto-restart wiring: a non-temporary child that exposes onExit reports abnormal death here.
    const exit = (service as Service | null)?.onExit;
    if (exit && (spec.restart ?? 'permanent') !== 'temporary') {
      exit.call(service, (reason) => void handleExit(spec.name, reason));
    } else if (!exit && (spec.restart === 'permanent' || spec.restart === 'transient')) {
      // The detectable footgun: you asked for restart, but the child can't report a crash, so it
      // will silently run as `temporary`. (The UNdetectable one — sharing mutable state between
      // children — no library can catch; the `get`/Store path is how you avoid needing to.)
      warn(
        `supervisor: child '${spec.name}' is restart:'${spec.restart}' but exposes no onExit() — ` +
          `it cannot report a crash, so it will NOT be auto-restarted. Give it an onExit(handler) ` +
          `seam, or set restart:'temporary'.`,
      );
    }
  };

  const stopChild = async (name: string): Promise<void> => {
    const stop = (services.get(name) as Service | null)?.stop;
    if (stop) await stop.call(services.get(name));
    services.delete(name);
  };

  // Apply the strategy: pick the affected set, stop it (reverse), start it again (forward). Fresh
  // starts re-`get` their siblings, so a restarted child sees the current instances.
  const handleExit = async (name: string, reason: unknown): Promise<void> => {
    if (!started) return; // ignore exits fired during shutdown
    const restart = specOf.get(name)?.restart ?? 'permanent';
    if (restart === 'temporary') return;
    if (restart === 'transient' && reason === undefined) return; // normal exit → leave it down

    // Restart intensity (OTP max_restarts/max_seconds): a crash-loop terminates the whole tree
    // rather than burning CPU restarting forever. OTP then escalates to the parent supervisor.
    const at = now();
    restartTimes.push(at);
    while (restartTimes.length && restartTimes[0] <= at - maxSeconds * 1000) restartTimes.shift();
    if (restartTimes.length > maxRestarts) {
      warn(
        `supervisor: restart intensity exceeded (${restartTimes.length} restarts within ` +
          `${maxSeconds}s) — shutting the tree down.`,
      );
      started = false;
      for (const child of [...order].reverse()) if (services.has(child)) await stopChild(child);
      options.onShutdown?.('restart-intensity');
      return;
    }

    const from = order.indexOf(name);
    const affected =
      strategy === 'one_for_one' ? [name] : strategy === 'rest_for_one' ? order.slice(from) : order;
    for (const child of [...affected].reverse()) if (services.has(child)) await stopChild(child);
    for (const child of affected) await startChild(specOf.get(child)!);
  };

  return {
    async start() {
      for (const spec of specs) await startChild(spec);
      started = true;
    },
    get,
    restartChild: (name) => handleExit(name, new Error('manual restart')),
    async stop() {
      started = false;
      for (const name of [...order].reverse()) if (services.has(name)) await stopChild(name);
    },
  };
}
