// The durability seam for a gen_server unit's state — the {@link Store} interface a backend
// implements, plus {@link memoryStore}, the in-process reference backend for tests and demos.
// Real backends live alongside: fileStore (./file-store.ts), postgresStore (./postgres-store.ts),
// raftStore (../job/raft-store.ts). A unit becomes durable by passing one as `genServer`'s `store`.

/**
 * A durable backing for a unit's state — Elixir would reach for mnesia or an external DB; this
 * is the seam, and you bring the backend (an in-memory {@link memoryStore} for tests, a
 * Postgres store for real durability — see examples/realtime-chat). State handed to `save`
 * must be structured-clone/JSON-safe for a real store.
 *
 * ```ts
 * const store = memoryStore();
 * await store.save('room:lobby', { members: ['ada'] });
 * await store.load('room:lobby'); // { members: ['ada'] }
 * ```
 */
export interface Store {
  /** The persisted state for `key`, or `undefined` if none — read once on (re)start. */
  load(key: string): Promise<unknown | undefined>;
  /** Durably persist `state` for `key`. Awaited BEFORE a reply is released (persist-before-ack). */
  save(key: string, state: unknown): Promise<void>;
  /** Forget `key` entirely. */
  clear(key: string): Promise<void>;
  /**
   * Atomically claim up to `limit` runnable jobs for `queue` — the multi-node coordinator of a
   * work queue, Oban's `SELECT … FOR UPDATE SKIP LOCKED` + mark-executing. Entries under `prefix`
   * are jobs `{ queue, state, scheduledAt, priority, attempt }`; a candidate has `state` in `ready`
   * and `scheduledAt <= now`. The first `limit`, ordered priority then scheduledAt, are each marked
   * `executing` with `attempt + 1`, persisted, and returned — in ONE turn (memoryStore) or ONE
   * transaction (Postgres), so concurrent drainers on separate nodes never grab the same job.
   * Omit it and {@link Job.queue} drains only its own in-memory inserts (single-writer).
   */
  claim?(
    prefix: string,
    queue: string,
    ready: readonly string[],
    now: number,
    limit: number,
  ): Promise<unknown[]>;
  /**
   * Atomically acquire or renew a lease on `key` for `candidate` for `ttlMs` — Elixir's `Oban.Peer`
   * leadership (a Postgres advisory lock, or the `:global` singleton). If `key` is unheld, expired,
   * or already `candidate`'s, it becomes `candidate`'s until `now + ttlMs`; either way the CURRENT
   * holder is returned (`=== candidate` ⇒ you lead). One turn (memoryStore) or one statement
   * (Postgres), so exactly one candidate ever holds it — the coordinator for cluster-once work (cron)
   * or, with no {@link Store.claim}, for electing a single drainer.
   *
   * TWO caveats a real backend must respect: (1) use the store's OWN clock for the expiry check
   * (Postgres `now()`), NOT the caller's `now` — across skewed node clocks a TTL lease would elect
   * two holders. (2) A TTL lease has a brief split-brain window if a holder pauses (GC/stall) past
   * its lease; the strongest backend is a session-scoped lock (a held Postgres advisory lock,
   * auto-released on disconnect — no TTL). For cron the stakes are low (a duplicate enqueue, mostly
   * deduped). `now` here is the in-process/test clock a `memoryStore` trusts.
   */
  lease?(key: string, candidate: string, now: number, ttlMs: number): Promise<string>;
  /**
   * Reset jobs stuck `executing` since before `staleBefore` (their `attemptedAt`) back to
   * `available` — the Stager/rescuer that recovers work orphaned when a node died mid-run (Oban's
   * rescuer). A job already out of attempts is `discarded` (dead-lettered) instead. Returns how many
   * were reset. Meant to run gated behind a {@link Leader} (once per cluster). `staleBefore` must be
   * older than the longest job runtime, or a still-running long job would be wrongly reclaimed.
   */
  rescue?(prefix: string, staleBefore: number): Promise<number>;
  /**
   * Every key beginning with `prefix`. Lets a caller enumerate its own keyspace (e.g. {@link Job.queue}
   * loading its jobs on boot) WITHOUT a separate rewrite-on-every-write index — the keys themselves
   * are the index. Optional: a store that can't cheaply list keys omits it, and callers fall back.
   */
  keys?(prefix: string): Promise<string[]>;
}

/**
 * An in-memory {@link Store} — for tests, doctests, and a single-process demo. Survives a
 * SUPERVISED restart of a unit within one process, but not process death (that needs a real
 * durable store). Snapshots by JSON round-trip so a later mutation can't change a saved copy.
 *
 * ```ts
 * const store = memoryStore();
 * await store.save('k', { n: 1 });
 * await store.load('k'); // { n: 1 }
 * await store.clear('k');
 * await store.load('k'); // undefined
 * ```
 */
export function memoryStore(): Store {
  const data = new Map<string, string>();
  return {
    load: (key) => Promise.resolve(data.has(key) ? JSON.parse(data.get(key)!) : undefined),
    save: (key, state) => (data.set(key, JSON.stringify(state)), Promise.resolve()),
    clear: (key) => (data.delete(key), Promise.resolve()),
    keys: (prefix) => Promise.resolve([...data.keys()].filter((k) => k.startsWith(prefix))),
    claim: (prefix, queue, ready, now, limit) => {
      // One synchronous turn — the in-process equivalent of FOR UPDATE SKIP LOCKED: no other tick
      // can interleave between selecting a candidate and marking it executing, so two drainers on
      // one store never claim the same job.
      const claimed = [...data.entries()]
        .filter(([key]) => key.startsWith(`${prefix}:`))
        .map(([key, raw]) => [key, JSON.parse(raw)] as [string, Record<string, unknown>])
        .filter(
          ([, job]) =>
            job.queue === queue &&
            ready.includes(job.state as string) &&
            (job.scheduledAt as number) <= now,
        )
        .sort(
          ([, a], [, b]) =>
            (a.priority as number) - (b.priority as number) ||
            (a.scheduledAt as number) - (b.scheduledAt as number),
        )
        .slice(0, limit)
        .map(([key, job]) => {
          const marked = {
            ...job,
            state: 'executing',
            attempt: (job.attempt as number) + 1,
            attemptedAt: now, // stamp when it started running — the stager keys on this
          };
          data.set(key, JSON.stringify(marked));
          return marked;
        });
      return Promise.resolve(claimed);
    },
    rescue: (prefix, staleBefore) => {
      let reset = 0;
      for (const [key, raw] of data.entries()) {
        if (!key.startsWith(`${prefix}:`)) continue;
        const job = JSON.parse(raw) as Record<string, unknown>;
        const attemptedAt = (job.attemptedAt as number | undefined) ?? Infinity; // unstamped = never stale
        if (job.state !== 'executing' || attemptedAt > staleBefore) continue;
        job.state =
          (job.attempt as number) >= (job.maxAttempts as number) ? 'discarded' : 'available';
        data.set(key, JSON.stringify(job));
        reset += 1;
      }
      return Promise.resolve(reset);
    },
    lease: (key, candidate, now, ttlMs) => {
      const raw = data.get(key);
      const held = raw ? (JSON.parse(raw) as { owner: string; expiresAt: number }) : undefined;
      if (!held || held.expiresAt <= now || held.owner === candidate) {
        data.set(key, JSON.stringify({ owner: candidate, expiresAt: now + ttlMs }));
        return Promise.resolve(candidate);
      }
      return Promise.resolve(held.owner);
    },
  };
}
