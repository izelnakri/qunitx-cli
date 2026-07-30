// Elixir's **Horde.DynamicSupervisor**: a set of keyed children spread ACROSS the cluster — each
// hosted on exactly one node, chosen by rendezvous hashing, and re-homed to a survivor when its
// host dies. Built on {@link shardedRegistry} (exactly-one ownership, serialized at the key's
// coordinator) + {@link rendezvous} (deterministic, even placement). The desired key set is
// symmetric — every node runs the same supervisor with the same `desired` — so placement and
// failover need no replicated spec log: a reconcile pass on each node hosts the keys IT owns and
// hands off the rest, and when the roster shrinks, rendezvous re-picks and survivors re-home.
//
// WHEN TO USE this vs {@link supervisor}: reach for `distributedSupervisor` for a large, DYNAMIC,
// INDEPENDENT keyspace spread across the cluster (a stateful actor per entity — rooms, carts,
// devices), where the job is PLACEMENT + node-death FAILOVER. Reach for `supervisor` for your app's
// fixed, ORDERED, interdependent skeleton on one node (store → jobs → web). They COMPOSE: this layer
// decides WHICH NODE hosts a key and survives node loss; a local `supervisor` inside each child
// decides what it's made of and restarts its parts IN PLACE. Node death is handled automatically
// here (roster liveness); an in-place child crash on a LIVE node is the local supervisor's job.
import type { NodeHandle } from './node.ts';
import type { ShardedRegistry } from './sharded-registry.ts';
import type { Service } from './supervisor.ts';
import { rendezvous } from './rendezvous.ts';

/** A running distributed supervisor — see {@link distributedSupervisor}. */
export interface DistributedSupervisor {
  /** Add a key to the desired set; a reconcile hosts it if this node owns it by rendezvous. */
  ensure(key: string): void;
  /** Drop a key from the desired set and stop it if hosted here. */
  remove(key: string): Promise<void>;
  /** The live owner of `key`, or `null` (a registry lookup). */
  whereis(key: string): Promise<string | null>;
  /** The child if it is hosted on THIS node, else undefined. */
  local(key: string): unknown | undefined;
  /** The keys currently hosted on THIS node. */
  hosted(): string[];
  /** Stop reconciling and tear down every child hosted here. */
  stop(): Promise<void>;
}

/**
 * Build a {@link DistributedSupervisor} over `node` and a `registry`. Every node in the cluster runs
 * one with the same `desired` set; each hosts the keys it wins by rendezvous, and a dead node's keys
 * re-home to survivors within a reconcile tick.
 *
 * ```ts
 * import { Node, memoryHub } from './node.ts';
 * import { shardedRegistry } from './sharded-registry.ts';
 * const node = Node.start('solo@ds', memoryHub().transport());
 * const sup = distributedSupervisor(node, shardedRegistry(node), {
 *   name: 'workers',
 *   start: (key) => ({ key }),
 * });
 * typeof sup.ensure; // 'function'
 * await sup.stop();
 * node.stop();
 * ```
 */
export function distributedSupervisor(
  node: NodeHandle,
  registry: ShardedRegistry,
  options: {
    name: string;
    start: (key: string) => unknown | Promise<unknown>;
    desired?: string[];
    peers?: () => string[];
    reconcileMs?: number;
  },
): DistributedSupervisor {
  const self = node.self();
  const roster = options.peers ?? (() => [self, ...node.list()]);
  const desired = new Set<string>(options.desired ?? []);
  const children = new Map<string, unknown>();
  let alive = true;
  let reconciling = false;

  const stopChild = async (key: string): Promise<void> => {
    const service = children.get(key) as Service | undefined;
    children.delete(key);
    await registry.unregister(options.name, key).catch(() => {});
    if (service && typeof service.stop === 'function') await service.stop();
  };

  // One pass: host every desired key this node now owns (claim, then start), hand off any it no
  // longer owns. Serialized by `reconciling` so overlapping ticks never double-start a key.
  const reconcile = async (): Promise<void> => {
    if (!alive || reconciling) return;
    reconciling = true;
    try {
      const live = roster();
      for (const key of desired) {
        if (rendezvous(key, live) === self) {
          if (!children.has(key)) {
            const claim = await registry.register(options.name, key, () => void stopChild(key));
            if ('ok' in claim && !children.has(key)) {
              const child = await options.start(key);
              children.set(key, child);
              // In-place restart: if the child dies abnormally while THIS node is alive, drop it so
              // the next reconcile re-claims and restarts it here (node-death re-homing is separate).
              (child as Service)?.onExit?.(() => void stopChild(key).then(() => reconcile()));
            }
          }
        } else if (children.has(key)) {
          await stopChild(key); // membership shifted — no longer ours
        }
      }
    } finally {
      reconciling = false;
    }
  };

  const timer = setInterval(() => void reconcile(), options.reconcileMs ?? 50);
  (timer as { unref?: () => void }).unref?.();
  void reconcile();

  return {
    ensure(key) {
      desired.add(key);
      void reconcile();
    },
    async remove(key) {
      desired.delete(key);
      if (children.has(key)) await stopChild(key);
    },
    whereis: (key) => registry.whereis(options.name, key),
    local: (key) => children.get(key),
    hosted: () => [...children.keys()],
    async stop() {
      alive = false;
      clearInterval(timer);
      for (const key of [...children.keys()]) await stopChild(key);
    },
  };
}
