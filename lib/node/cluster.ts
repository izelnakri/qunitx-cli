/**
 * Automatic cluster formation — Elixir's **libcluster**: nodes discover each other and connect
 * without a hardcoded peer list. libcluster's core is a polling *strategy* (Epmd, Kubernetes,
 * DNS, Gossip) that periodically reports the set of peers that *should* be connected; the manager
 * diffs that against who IS connected and calls `connect`/`disconnect` to converge. This is that
 * manager, transport-agnostic: you supply the discovery `strategy` and a `connect` that dials one
 * peer (open a {@link Transport} to it), and it keeps the topology in sync.
 *
 * The strategy stays platform-specific and out of the universal core — an env var, a DNS SRV
 * lookup, a Kubernetes endpoints query — while the diff/connect loop is universal and testable
 * (drive it with `poll()`, no timers).
 *
 * ```ts
 * const dialed: string[] = [];
 * let peers = ['a@host', 'b@host'];
 * const c = cluster({ strategy: () => peers, connect: (p) => void dialed.push(p) });
 * await c.poll();
 * dialed; // ['a@host', 'b@host'] — both dialed on first sight
 * peers = ['a@host', 'b@host', 'c@host'];
 * await c.poll();
 * dialed; // ['a@host', 'b@host', 'c@host'] — only the newcomer is dialed
 * ```
 */

/** A running cluster-formation manager — see {@link cluster}. */
export interface Cluster {
  /** Begin polling the strategy every `pollMs` (unref'd, so it never keeps a process alive). */
  start(): void;
  /** Stop polling. */
  stop(): void;
  /** Run one discovery pass now: connect newly-seen peers, disconnect departed ones. */
  poll(): Promise<void>;
  /** The peers currently considered connected. */
  connected(): string[];
}

/**
 * Builds a {@link Cluster} manager. `strategy` returns the peers that should be connected (sync or
 * async — a DNS/API lookup); `connect` dials a newly-seen peer; `disconnect` (optional) tears down
 * one that vanished from discovery. Each `poll` diffs the strategy's result against the connected
 * set — new peers are dialed once, departed peers dropped — so discovery is idempotent and
 * self-healing. `self` (optional) is excluded so a node never dials itself.
 *
 * ```ts
 * const c = cluster({ strategy: () => ['n@1'], connect: () => {}, self: 'n@1' });
 * await c.poll();
 * c.connected(); // [] — 'self' is never dialed
 * ```
 */
export function cluster(options: {
  strategy: () => Iterable<string> | Promise<Iterable<string>>;
  connect: (peer: string) => void;
  disconnect?: (peer: string) => void;
  self?: string;
  pollMs?: number;
}): Cluster {
  const pollMs = options.pollMs ?? 5000;
  const connected = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const poll = async (): Promise<void> => {
    const discovered = new Set(await options.strategy());
    discovered.delete(options.self ?? ''); // never dial self
    for (const peer of discovered) {
      if (!connected.has(peer)) {
        connected.add(peer);
        options.connect(peer); // a newly-seen peer — dial it once
      }
    }
    for (const peer of [...connected]) {
      if (!discovered.has(peer)) {
        connected.delete(peer);
        options.disconnect?.(peer); // vanished from discovery — drop it
      }
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void poll(), pollMs);
      (timer as { unref?: () => void }).unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    poll,
    connected: () => [...connected],
  };
}
