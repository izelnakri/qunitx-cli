/**
 * `shardedRegistry` — the **partitioned registry**: frontier #1, closed. The replicated registry
 * (the CRDT under `register`/`whereis`/`via:`) holds EVERY entry on EVERY node — Horde's design
 * and Horde's ceiling: one node's memory bounds the whole keyspace, and anti-entropy is
 * O(entries) per sync. This registry shards instead: each key lives on exactly ONE
 * **coordinator** node, chosen by rendezvous hashing over the roster, so a node holds only the
 * keys it coordinates — memory and sync cost scale WITH the cluster. A billion-key registry is
 * "add nodes", which is beyond what Elixir's `Registry` or Horde does.
 *
 * Sharding also buys back a semantic the AP registry gave up: the coordinator SERIALIZES claims
 * on its keys, so a duplicate registration is **rejected synchronously** (`{ error: 'taken' }`) —
 * Elixir's local-Registry behavior, at cluster scope. The costs are a routing hop (every op is
 * async — this is exactly the sync→async migration the scaling notes promised #1 would require)
 * and availability coupling to the coordinator: when membership changes, rendezvous re-picks and
 * every owner **re-homes** its keys to the new coordinator; a claim that lost a churn race fires
 * `onConflict` (the loser tears down, `via`-style). During a partition each side elects its own
 * coordinators — AP across partitions, serialized within one — and heals by re-homing.
 *
 * ```ts
 * import { start, memoryHub } from './node.ts';
 * const node = start('solo@sr', memoryHub().transport());
 * const registry = shardedRegistry(node);
 * await registry.register('rooms', 'lobby'); // { ok: true }
 * await registry.whereis('rooms', 'lobby'); // 'solo@sr'
 * await registry.register('rooms', 'lobby'); // { ok: true } — re-claiming your own key is a no-op
 * node.stop();
 * ```
 */
import { rendezvous } from './rendezvous.ts';
import type { NodeHandle } from './node.ts';

const CLAIM = 'sharded-registry.claim';
const RELEASE = 'sharded-registry.release';
const WHEREIS = 'sharded-registry.whereis';
const KEYS = 'sharded-registry.keys';
const SEP = '\u001f'; // unit separator — cannot appear in a registry name or key

/** The outcome of a claim: yours, or already owned (with the current owner). */
export type ClaimResult = { ok: true } | { error: 'taken'; owner: string };

/** A partitioned registry over a node — see {@link shardedRegistry}. */
export interface ShardedRegistry {
  /**
   * Claim `key` in `registry` for this node — routed to the key's coordinator, which serializes
   * claims: a duplicate is rejected SYNCHRONOUSLY with the current owner (Elixir local-Registry
   * semantics at cluster scope). `onConflict` fires if the key is later lost to a churn race
   * (re-home collision) — tear down whatever was served under it, `via`-style.
   */
  register(registry: string, key: string, onConflict?: () => void): Promise<ClaimResult>;
  /** Release a key this node owns. */
  unregister(registry: string, key: string): Promise<void>;
  /** The live owner of `key`, or `null` — one hop to the key's coordinator. */
  whereis(registry: string, key: string): Promise<string | null>;
  /** Every registered key in `registry` — scatter-gather across all coordinators. */
  keys(registry: string): Promise<string[]>;
}

/**
 * Build a {@link ShardedRegistry} over `node`. EVERY node in the roster must run one (it
 * registers the coordinator handlers at construction — same rule as `shardedPresence`).
 * `peers()` is the coordinator roster (default: this node plus its live peers).
 *
 * ```ts
 * import { start, memoryHub } from './node.ts';
 * const node = start('n@sr2', memoryHub().transport());
 * const registry = shardedRegistry(node);
 * await registry.whereis('rooms', 'nowhere'); // null
 * node.stop();
 * ```
 */
export function shardedRegistry(
  node: NodeHandle,
  options: { peers?: () => string[] } = {},
): ShardedRegistry {
  const self = node.self();
  const roster = options.peers ?? (() => [self, ...node.list()]);
  const coordinatorOf = (registry: string, key: string): string =>
    rendezvous(`${registry}${SEP}${key}`, roster()) ?? self;

  // Coordinator-side shard: rk -> owner, only for keys I coordinate. The single writer per key
  // is what makes rejection synchronous — claims on one key serialize through one node.
  const shard = new Map<string, string>();
  const rk = (registry: string, key: string) => `${registry}${SEP}${key}`;
  const live = (owner: string): boolean => owner === self || node.list().includes(owner);

  const claimLocal = (registry: string, key: string, owner: string): ClaimResult => {
    const id = rk(registry, key);
    const current = shard.get(id);
    if (current !== undefined && current !== owner && live(current))
      return { error: 'taken', owner: current };
    shard.set(id, owner); // fresh, re-claimed by its owner, or abandoned by a dead one
    return { ok: true };
  };
  const releaseLocal = (registry: string, key: string, owner: string): void => {
    if (shard.get(rk(registry, key)) === owner) shard.delete(rk(registry, key));
  };
  const whereisLocal = (registry: string, key: string): string | null => {
    const owner = shard.get(rk(registry, key));
    return owner !== undefined && live(owner) ? owner : null;
  };
  const keysLocal = (registry: string): string[] => {
    const prefix = `${registry}${SEP}`;
    const out: string[] = [];
    for (const [id, owner] of shard)
      if (id.startsWith(prefix) && live(owner)) out.push(id.slice(prefix.length));
    return out;
  };

  node.handle(CLAIM, (raw) => {
    const r = raw as { registry: string; key: string; owner: string };
    return claimLocal(r.registry, r.key, r.owner);
  });
  node.handle(RELEASE, (raw) => {
    const r = raw as { registry: string; key: string; owner: string };
    releaseLocal(r.registry, r.key, r.owner);
  });
  node.handle(WHEREIS, (raw) => {
    const r = raw as { registry: string; key: string };
    return whereisLocal(r.registry, r.key);
  });
  node.handle(KEYS, (raw) => keysLocal((raw as { registry: string }).registry));

  // Liveness: a downed owner's keys are freed from the shards I coordinate.
  node.monitor((down) => {
    for (const [id, owner] of [...shard]) if (owner === down) shard.delete(id);
  });

  // My own claims, tagged with the coordinator each was accepted by (for re-homing).
  const mine = new Map<
    string,
    { registry: string; key: string; coord: string; onConflict?: () => void }
  >();

  const claimAt = (registry: string, key: string, coord: string): Promise<ClaimResult> =>
    coord === self
      ? Promise.resolve(claimLocal(registry, key, self))
      : node.call<ClaimResult>(coord, CLAIM, { registry, key, owner: self });
  const releaseAt = (registry: string, key: string, coord: string): void => {
    if (coord === self) releaseLocal(registry, key, self);
    else node.cast(coord, RELEASE, { registry, key, owner: self });
  };

  // On any membership change, re-home each of my keys whose coordinator moved. A claim that
  // LOSES at the new coordinator (someone else re-homed first) fires onConflict — the loser
  // tears down, exactly like a via-registration losing a partition-heal tiebreak.
  node.monitorNodes(async () => {
    for (const [id, entry] of [...mine]) {
      const coord = coordinatorOf(entry.registry, entry.key);
      if (coord === entry.coord) continue;
      releaseAt(entry.registry, entry.key, entry.coord); // best-effort removal from the old one
      const result = await claimAt(entry.registry, entry.key, coord).catch(
        (): ClaimResult => ({ ok: true }), // coordinator unreachable — keep the claim, retry next churn
      );
      if ('error' in result) {
        mine.delete(id);
        entry.onConflict?.();
      } else {
        mine.set(id, { ...entry, coord });
      }
    }
  });

  return {
    async register(registry, key, onConflict) {
      const coord = coordinatorOf(registry, key);
      const result = await claimAt(registry, key, coord);
      if ('ok' in result) mine.set(rk(registry, key), { registry, key, coord, onConflict });
      return result;
    },
    unregister(registry, key) {
      const entry = mine.get(rk(registry, key));
      if (entry) {
        mine.delete(rk(registry, key));
        releaseAt(registry, key, entry.coord);
      }
      return Promise.resolve();
    },
    whereis(registry, key) {
      const coord = coordinatorOf(registry, key);
      return coord === self
        ? Promise.resolve(whereisLocal(registry, key))
        : node.call<string | null>(coord, WHEREIS, { registry, key });
    },
    async keys(registry) {
      // Scatter-gather: every coordinator owns a slice of the keyspace.
      const nodes = new Set([self, ...roster()]);
      const slices = await Promise.all(
        [...nodes].map((peer) =>
          peer === self
            ? Promise.resolve(keysLocal(registry))
            : node.call<string[]>(peer, KEYS, { registry }).catch(() => [] as string[]),
        ),
      );
      return [...new Set(slices.flat())];
    },
  };
}
