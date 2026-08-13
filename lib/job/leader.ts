import type { Store } from '../node/store.ts';

/**
 * "Am I the one node that should run this?" — Elixir's `Oban.Peer` (or a `Highlander` singleton).
 * A cluster runs the same periodic work everywhere (cron, pruning, a store-less drainer), but it
 * must happen ONCE; the leader is the node allowed to.
 */
export interface Leader {
  /** True iff this instance currently holds the lease — safe to run the cluster-once work. */
  isLeader(): boolean;
  /** Stop renewing and drop local leadership (the lease then expires for a survivor to take). */
  stop(): void;
}

/**
 * Elects ONE holder across a cluster by renewing a {@link Store.lease} — the store-backed
 * leadership Oban uses for Cron/Pruner (`Oban.Peers.Postgres`, a DB advisory lock). Every candidate
 * renews on an interval; whoever holds the lease leads, and if it dies the lease expires so a
 * survivor takes over within `leaseMs`. `isLeader()` also guards against acting on a locally-stale
 * lease (never leads past `heldUntil`). With no {@link Store.lease} it never leads (single node);
 * for a STORE-LESS cluster, elect through the CP Raft leader instead (`raft.role() === 'leader'`) —
 * stronger than Elixir's `:global`, which can split-brain.
 *
 * ```ts
 * import { memoryStore } from '../node/index.ts';
 *
 * const store = memoryStore();
 * const a = leader({ store, key: 'jobs:cron', candidate: 'a@c', leaseMs: 1000 });
 * const b = leader({ store, key: 'jobs:cron', candidate: 'b@c', leaseMs: 1000 });
 * await new Promise((r) => setTimeout(r, 10)); // let the first renew land
 * a.isLeader() !== b.isLeader(); // true — exactly one leads
 * a.stop();
 * b.stop();
 * ```
 */
export function leader(opts: {
  store: Store;
  key: string;
  candidate: string;
  leaseMs?: number;
  now?: () => number;
}): Leader {
  // A CP store (raftStore) elects ONE leader per group through Raft terms + quorum votes — not a
  // wall-clock TTL — so there is no clock-skew split-brain (the one real weakness of the lease path:
  // a raft-COMMITTED lease still compares TTL expiry against caller clocks, native Raft leadership
  // does not). Prefer it: leadership is simply this node's Raft role; `key`/`candidate` are the
  // group's, not per-key. Nothing to release on stop — leadership belongs to the Raft group.
  const raft = (opts.store as { raft?: { role?: () => string } }).raft;
  if (raft && typeof raft.role === 'function') {
    return { isLeader: () => raft.role!() === 'leader', stop: () => {} };
  }
  const lease = opts.store.lease;
  // Fail loudly: a store with no lease can never coordinate leadership, and a silent leader that
  // never leads would DISABLE cron (evaluateCron gates on isLeader). Better a clear error at wiring.
  if (!lease) {
    throw new TypeError(
      'leader() needs a Store that implements lease() — memoryStore, raftStore, or a Postgres ' +
        'store with an advisory lock. Without it, leadership (and cron) can never fire.',
    );
  }
  const leaseMs = opts.leaseMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  let held = false;
  let heldUntil = 0;
  let alive = true;

  const renew = async (): Promise<void> => {
    if (!alive) return;
    const owner = await lease(opts.key, opts.candidate, now(), leaseMs);
    held = owner === opts.candidate;
    heldUntil = now() + leaseMs;
  };
  void renew();
  // Renew well within the TTL so a live leader never lapses; a third of the lease is the usual margin.
  const timer = setInterval(() => void renew(), Math.max(50, Math.floor(leaseMs / 3)));
  (timer as { unref?: () => void }).unref?.();

  return {
    isLeader: () => alive && held && now() < heldUntil,
    stop: () => {
      const wasLeader = alive && held && now() < heldUntil;
      alive = false;
      held = false;
      clearInterval(timer);
      // Graceful release: expire our OWN lease now (ttl 0) so a survivor takes over immediately
      // instead of waiting out leaseMs — a planned rolling deploy has no leadership gap. Only when
      // we actually held it (never touches another node's lease); a CRASH can't do this, so that
      // failover still waits for the lease to lapse.
      if (wasLeader) void lease(opts.key, opts.candidate, now(), 0);
    },
  };
}
