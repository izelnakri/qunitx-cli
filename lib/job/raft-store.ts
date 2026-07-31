import { Failure, isFailure, type Any as AnyFailure } from '../result/failure.ts';
import { raft, type Raft } from '../raft/raft.ts';
import type { NodeHandle } from '../node/node.ts';
import type { Store } from '../node/store.ts';

/** The replicated state: a plain KV (JSON-safe, so Raft can snapshot it). */
type KV = Record<string, unknown>;

type Command =
  | { op: 'save'; key: string; value: unknown }
  | { op: 'clear'; key: string }
  | {
      op: 'claim';
      prefix: string;
      queue: string;
      ready: readonly string[];
      now: number;
      limit: number;
    }
  | { op: 'lease'; key: string; candidate: string; now: number; ttlMs: number }
  | { op: 'rescue'; prefix: string; staleBefore: number };

// The KV state machine — memoryStore's claim/lease semantics, but as DETERMINISTIC Raft commands
// (every replica applies the same command to the same state), so `now` rides IN the command, never
// read from each node's clock during apply. A committed claim/lease is thus atomic cluster-wide.
function apply(command: unknown, state: KV): { state: KV; reply?: unknown } {
  const cmd = command as Command;
  const next: KV = { ...state };
  if (cmd.op === 'save') {
    next[cmd.key] = cmd.value;
    return { state: next };
  }
  if (cmd.op === 'clear') {
    delete next[cmd.key];
    return { state: next };
  }
  if (cmd.op === 'claim') {
    const claimed = Object.entries(next)
      .filter(([key]) => key.startsWith(`${cmd.prefix}:`))
      .map(([key, job]) => [key, job as Record<string, unknown>] as const)
      .filter(
        ([, job]) =>
          job.queue === cmd.queue &&
          cmd.ready.includes(job.state as string) &&
          (job.scheduledAt as number) <= cmd.now,
      )
      .sort(
        ([, a], [, b]) =>
          (a.priority as number) - (b.priority as number) ||
          (a.scheduledAt as number) - (b.scheduledAt as number),
      )
      .slice(0, cmd.limit)
      .map(([key, job]) => {
        const marked = {
          ...job,
          state: 'executing',
          attempt: (job.attempt as number) + 1,
          attemptedAt: cmd.now, // stamp for the stager — replicas apply the same `now`
        };
        next[key] = marked;
        return marked;
      });
    return { state: next, reply: claimed };
  }
  if (cmd.op === 'rescue') {
    let reset = 0;
    for (const [key, value] of Object.entries(next)) {
      if (!key.startsWith(`${cmd.prefix}:`)) continue;
      const job = value as Record<string, unknown>;
      const attemptedAt = (job.attemptedAt as number | undefined) ?? Infinity;
      if (job.state !== 'executing' || attemptedAt > cmd.staleBefore) continue;
      next[key] = {
        ...job,
        state: (job.attempt as number) >= (job.maxAttempts as number) ? 'discarded' : 'available',
      };
      reset += 1;
    }
    return { state: next, reply: reset };
  }
  // lease
  const held = next[cmd.key] as { owner: string; expiresAt: number } | undefined;
  if (!held || held.expiresAt <= cmd.now || held.owner === cmd.candidate) {
    next[cmd.key] = { owner: cmd.candidate, expiresAt: cmd.now + cmd.ttlMs };
    return { state: next, reply: cmd.candidate };
  }
  return { state: next, reply: held.owner };
}

/**
 * A {@link Store} whose state is a Raft-replicated KV — the in-house, external-DB-free distributed
 * store. Every save/clear/claim/lease is a committed Raft command, so `claim` and `lease` are
 * LINEARIZABLE across the cluster: Raft's atomicity replaces Postgres's `SKIP LOCKED` / advisory
 * lock, so every node runs the same {@link Job.queue} against it and the claim hands each job to
 * exactly one node — no leader election bolted on, no double execution. Durability is
 * majority-replicated (each member persists its Raft log via `persistence`, default in-memory).
 * Reads (`load`) are LOCAL (eventually consistent — the linearizable ops are the ones that matter).
 * A follower forwards mutations to the leader (Raft rejects a non-leader propose). Cost: one
 * consensus round per mutation — fits moderate-throughput queues; a firehose still wants Postgres.
 *
 * ```ts
 * import { Node, memoryHub } from '../node/index.ts';
 *
 * const node = Node.start('n@raft', memoryHub().transport());
 * const store = raftStore(node, { peers: ['n@raft'], electionTimeoutMs: () => 15 });
 * await new Promise((r) => setTimeout(r, 60)); // the single-member group elects itself
 * await store.save('greeting', 'hi');
 * await store.load('greeting'); // 'hi'
 * store.stop();
 * node.stop();
 * ```
 */
export function raftStore(
  node: NodeHandle,
  options: {
    peers: string[];
    group?: string;
    persistence?: Store;
    heartbeatMs?: number;
    electionTimeoutMs?: () => number;
  },
): Store & { raft: Raft<KV>; stop: () => void } {
  const group = options.group ?? 'store';
  const FORWARD = `raftstore.${group}.propose`;
  const r = raft<KV>(node, {
    peers: options.peers,
    group,
    init: () => ({}),
    apply,
    store: options.persistence,
    heartbeatMs: options.heartbeatMs,
    electionTimeoutMs: options.electionTimeoutMs,
  });
  // A follower forwards its proposal here to the leader, which appends it and answers apply's reply.
  node.handle(FORWARD, (command) => r.propose(command));

  const propose = async (command: Command): Promise<unknown> => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        if (r.role() === 'leader') return await r.propose(command);
        const leaderId = r.leader();
        if (leaderId && leaderId !== node.self())
          return await node.call(leaderId, FORWARD, command);
      } catch (error) {
        if (!(isFailure(error) && (error as AnyFailure).code === 'NotLeader')) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25)); // leader unknown/changing — let it settle
    }
    throw new Failure('NotLeader', 'raftStore: no leader elected after retries', { group });
  };

  return {
    raft: r,
    stop: () => r.stop(),
    load: (key) => Promise.resolve(r.state()[key]),
    save: (key, value) => propose({ op: 'save', key, value }).then(() => undefined),
    clear: (key) => propose({ op: 'clear', key }).then(() => undefined),
    claim: (prefix, queue, ready, now, limit) =>
      propose({ op: 'claim', prefix, queue, ready: [...ready], now, limit }) as Promise<unknown[]>,
    lease: (key, candidate, now, ttlMs) =>
      propose({ op: 'lease', key, candidate, now, ttlMs }) as Promise<string>,
    rescue: (prefix, staleBefore) =>
      propose({ op: 'rescue', prefix, staleBefore }) as Promise<number>,
  };
}
