/**
 * `Raft` — CP consensus (frontier #2): Erlang `ra`'s role in this system, built from the Raft
 * paper's §5 core. Where the CRDT registry is AP (always available, converges after a partition),
 * a Raft group is **CP**: commands are appended to a replicated log, committed only when a
 * MAJORITY has them, and applied in the same order everywhere — so a minority partition can never
 * commit (no split-brain decisions, ever), at the price of unavailability without a quorum. Use
 * it for the few decisions that must be linearizable — a lock, a lease, a unique-sequence — and
 * keep everything else on the AP layer.
 *
 * The classic algorithm, honestly scoped: leader election (randomized timeouts, term voting,
 * log-up-to-date check), log replication (AppendEntries with consistency check and conflict
 * truncation), majority commit (only entries from the CURRENT term commit by counting — §5.4.2),
 * and a deterministic state machine (`apply`) that every member replays identically. Static
 * membership; no snapshots/log compaction (the log grows — bound it at the app layer);
 * persistence rides the {@link Store} seam (term/vote/log saved before answering, so a restarted
 * member rejoins safely) — in-memory without one. That is `ra` minus its production extras,
 * stated plainly.
 *
 * ```ts
 * import { start, memoryHub } from '../node/index.ts';
 * // A single-member group is a majority of one — it elects itself and commits immediately.
 * const node = start('solo@raft', memoryHub().transport());
 * const counter = raft<number>(node, {
 *   peers: ['solo@raft'],
 *   init: () => 0,
 *   apply: (command, state) => ({ state: state + (command as number), reply: state + (command as number) }),
 *   electionTimeoutMs: () => 10,
 * });
 * await new Promise((r) => setTimeout(r, 50)); // election timeout fires — leader of one
 * await counter.propose(42); // 42 — committed by the majority (itself), applied
 * counter.stop();
 * node.stop();
 * ```
 */
import { Failure } from '../result/failure.ts';
import type { NodeHandle } from '../node/node.ts';
import type { Store } from '../node/upgradable.ts';

/** One replicated log entry: the term it was proposed in, and the command to apply. */
export interface LogEntry {
  /** The leader term that appended this entry. */
  term: number;
  /** The state-machine command — structured-clone-safe. */
  command: unknown;
  /** A leader-election no-op (never reaches `apply`) — how a new leader commits its predecessor's
   *  tail: §5.4.2 forbids committing old-term entries by counting, so each election appends one
   *  entry from the NEW term, and committing it commits everything before it (ra/etcd do this). */
  noop?: boolean;
}

/** A member's role — the Raft state machine of states. */
export type RaftRole = 'follower' | 'candidate' | 'leader';

/** A running Raft member — see {@link raft}. */
export interface Raft<S> {
  /**
   * Propose a command. On the leader it resolves with `apply`'s reply once the entry is
   * COMMITTED (majority-replicated) and applied; on any other member it rejects immediately with
   * a declared `NotLeader` failure carrying the current leader hint — retry there.
   */
  propose(command: unknown): Promise<unknown>;
  /** This member's current role. */
  role(): RaftRole;
  /** The member believed to be leader, or null before one is known. */
  leader(): string | null;
  /** The current term. */
  term(): number;
  /** The applied state — local, may lag the leader; a linearizable read is a proposed no-op. */
  state(): S;
  /** The highest committed log index (1-based; 0 = nothing committed). */
  committedIndex(): number;
  /** Leave the group: stop timers, reject in-flight proposals. */
  stop(): void;
}

const NOT_LEADER = 'NotLeader';

/**
 * Start a Raft member for `group` on `node`. `peers` is the FULL static membership (self
 * included); every member must run with the same list. `apply` must be deterministic — it replays
 * identically on every member. `electionTimeoutMs` is injectable for deterministic tests
 * (production default: randomized 150–300ms, the paper's spread).
 *
 * ```ts
 * import { start, memoryHub } from '../node/index.ts';
 * const node = start('m@raft', memoryHub().transport());
 * const member = raft<number>(node, { peers: ['m@raft'], init: () => 0, apply: (c, s) => ({ state: s }) });
 * member.role(); // 'follower' — everyone starts as a follower
 * member.stop();
 * node.stop();
 * ```
 */
export function raft<S>(
  node: NodeHandle,
  options: {
    peers: string[];
    init: () => S;
    apply: (command: unknown, state: S) => { state: S; reply?: unknown };
    group?: string;
    electionTimeoutMs?: () => number;
    heartbeatMs?: number;
    store?: Store;
    storeKey?: string;
  },
): Raft<S> {
  const self = node.self();
  const group = options.group ?? 'raft';
  const others = options.peers.filter((peer) => peer !== self);
  const majority = Math.floor(options.peers.length / 2) + 1;
  const electionTimeoutMs = options.electionTimeoutMs ?? (() => 150 + Math.random() * 150);
  const heartbeatMs = options.heartbeatMs ?? 50;
  const VOTE = `raft.${group}.vote`;
  const APPEND = `raft.${group}.append`;
  const storeKey = options.storeKey ?? `raft:${group}:${self}`;

  // ---- Persistent state (saved via the Store seam before answering, per the paper) ----
  let currentTerm = 0;
  let votedFor: string | null = null;
  let log: LogEntry[] = []; // log[i] is 1-based index i+1

  // ---- Volatile state ----
  let role: RaftRole = 'follower';
  let leaderId: string | null = null;
  let commitIndex = 0;
  let lastApplied = 0;
  let state = options.init();
  let alive = true;
  const nextIndex = new Map<string, number>();
  const matchIndex = new Map<string, number>();
  const pending = new Map<
    number,
    { term: number; resolve: (r: unknown) => void; reject: (e: unknown) => void }
  >();

  const lastLogIndex = (): number => log.length;
  const termAt = (index: number): number => (index === 0 ? 0 : log[index - 1].term);

  const persist = (): Promise<void> =>
    options.store
      ? options.store.save(storeKey, { currentTerm, votedFor, log })
      : Promise.resolve();

  // A restarted member rejoins with its promises intact (term, vote, log) — Raft's safety
  // depends on this surviving a crash when a Store is provided.
  const loaded: Promise<void> = options.store
    ? options.store.load(storeKey).then((saved) => {
        if (saved) {
          const s = saved as { currentTerm: number; votedFor: string | null; log: LogEntry[] };
          currentTerm = s.currentTerm;
          votedFor = s.votedFor;
          log = s.log;
        }
      })
    : Promise.resolve();

  // ---- Timers ----
  let electionTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const resetElectionTimer = (): void => {
    if (electionTimer) clearTimeout(electionTimer);
    electionTimer = setTimeout(() => void startElection(), electionTimeoutMs());
    (electionTimer as { unref?: () => void }).unref?.();
  };

  const applyCommitted = (): void => {
    while (lastApplied < commitIndex) {
      lastApplied++;
      const entry = log[lastApplied - 1];
      let reply: unknown;
      if (!entry.noop) {
        const outcome = options.apply(entry.command, state);
        state = outcome.state;
        reply = outcome.reply;
      }
      const waiter = pending.get(lastApplied);
      if (waiter) {
        pending.delete(lastApplied);
        if (waiter.term === entry.term) waiter.resolve(reply);
        else
          waiter.reject(
            new Failure(NOT_LEADER, 'entry was overwritten by a new leader', { leader: leaderId }),
          );
      }
    }
  };

  const stepDown = async (term: number, leader: string | null): Promise<void> => {
    const wasLeader = role === 'leader';
    if (term > currentTerm) {
      currentTerm = term;
      votedFor = null;
      await persist();
    }
    role = 'follower';
    if (leader !== null) leaderId = leader;
    if (wasLeader && heartbeatTimer) clearInterval(heartbeatTimer);
    if (wasLeader) {
      for (const [index, waiter] of [...pending]) {
        pending.delete(index);
        waiter.reject(new Failure(NOT_LEADER, 'lost leadership', { leader: leaderId }));
      }
    }
    resetElectionTimer();
  };

  // ---- Leader: replication + commit ----
  const replicateTo = async (peer: string): Promise<void> => {
    if (role !== 'leader' || !alive) return;
    const next = nextIndex.get(peer) ?? lastLogIndex() + 1;
    const prevIndex = next - 1;
    const entries = log.slice(next - 1);
    try {
      const reply = (await node.call(
        peer,
        APPEND,
        {
          term: currentTerm,
          leader: self,
          prevIndex,
          prevTerm: termAt(prevIndex),
          entries,
          leaderCommit: commitIndex,
        },
        heartbeatMs * 4,
      )) as { term: number; success: boolean; matchIndex?: number };
      if (!alive || role !== 'leader') return;
      if (reply.term > currentTerm) return void (await stepDown(reply.term, null));
      if (reply.success) {
        matchIndex.set(peer, reply.matchIndex!);
        nextIndex.set(peer, reply.matchIndex! + 1);
        advanceCommit();
      } else {
        nextIndex.set(peer, Math.max(1, next - 1)); // walk back — retry next heartbeat
      }
    } catch {
      // peer unreachable — the next heartbeat retries
    }
  };

  const advanceCommit = (): void => {
    // §5.4.2: only entries from the CURRENT term commit by counting replicas.
    for (let n = lastLogIndex(); n > commitIndex; n--) {
      if (termAt(n) !== currentTerm) break;
      const replicas = 1 + others.filter((peer) => (matchIndex.get(peer) ?? 0) >= n).length;
      if (replicas >= majority) {
        commitIndex = n;
        applyCommitted();
        break;
      }
    }
  };

  const becomeLeader = (): void => {
    role = 'leader';
    leaderId = self;
    if (electionTimer) clearTimeout(electionTimer);
    // The election no-op (§5.4.2): committing this NEW-term entry is what lets us commit the
    // previous leader's replicated-but-uncommitted tail — old-term entries never commit by count.
    log.push({ term: currentTerm, command: null, noop: true });
    for (const peer of others) {
      nextIndex.set(peer, lastLogIndex()); // start at the no-op; walk back on mismatch
      matchIndex.set(peer, 0);
    }
    const beat = (): void => void Promise.all(others.map(replicateTo));
    heartbeatTimer = setInterval(beat, heartbeatMs);
    (heartbeatTimer as { unref?: () => void }).unref?.();
    void persist().then(() => {
      beat(); // announce immediately — stops other elections
      advanceCommit(); // a majority of one commits right here
    });
  };

  // ---- Candidate: election ----
  const startElection = async (): Promise<void> => {
    if (!alive || role === 'leader') return;
    role = 'candidate';
    currentTerm++;
    votedFor = self;
    leaderId = null;
    await persist();
    const electionTerm = currentTerm;
    resetElectionTimer(); // a split vote retries with a fresh timeout
    const votes = await Promise.all(
      others.map((peer) =>
        node
          .call(
            peer,
            VOTE,
            {
              term: electionTerm,
              candidate: self,
              lastLogIndex: lastLogIndex(),
              lastLogTerm: termAt(lastLogIndex()),
            },
            Math.max(heartbeatMs * 3, 60),
          )
          .then((r) => r as { term: number; granted: boolean })
          .catch(() => ({ term: 0, granted: false })),
      ),
    );
    if (!alive || role !== 'candidate' || currentTerm !== electionTerm) return; // superseded
    const higher = votes.find((v) => v.term > currentTerm);
    if (higher) return void (await stepDown(higher.term, null));
    const granted = 1 + votes.filter((v) => v.granted).length;
    if (granted >= majority) becomeLeader();
  };

  // ---- RPC receivers ----
  node.handle(VOTE, async (raw) => {
    await loaded;
    const req = raw as {
      term: number;
      candidate: string;
      lastLogIndex: number;
      lastLogTerm: number;
    };
    if (req.term < currentTerm) return { term: currentTerm, granted: false };
    if (req.term > currentTerm) await stepDown(req.term, null);
    const upToDate =
      req.lastLogTerm > termAt(lastLogIndex()) ||
      (req.lastLogTerm === termAt(lastLogIndex()) && req.lastLogIndex >= lastLogIndex());
    const granted = (votedFor === null || votedFor === req.candidate) && upToDate;
    if (granted) {
      votedFor = req.candidate;
      await persist();
      resetElectionTimer(); // granting a vote defers our own candidacy
    }
    return { term: currentTerm, granted };
  });

  node.handle(APPEND, async (raw) => {
    await loaded;
    const req = raw as {
      term: number;
      leader: string;
      prevIndex: number;
      prevTerm: number;
      entries: LogEntry[];
      leaderCommit: number;
    };
    if (req.term < currentTerm) return { term: currentTerm, success: false };
    await stepDown(req.term, req.leader); // a valid leader's append always re-follows + resets the timer
    // Consistency check: our log must contain the entry the leader is appending after.
    if (
      req.prevIndex > 0 &&
      (lastLogIndex() < req.prevIndex || termAt(req.prevIndex) !== req.prevTerm)
    ) {
      return { term: currentTerm, success: false };
    }
    // Append, truncating any conflicting suffix (§5.3).
    let changed = false;
    for (let k = 0; k < req.entries.length; k++) {
      const index = req.prevIndex + 1 + k;
      if (lastLogIndex() >= index && termAt(index) !== req.entries[k].term) {
        log = log.slice(0, index - 1);
        changed = true;
      }
      if (lastLogIndex() < index) {
        log.push(req.entries[k]);
        changed = true;
      }
    }
    if (changed) await persist();
    const matched = req.prevIndex + req.entries.length;
    if (req.leaderCommit > commitIndex) {
      commitIndex = Math.min(req.leaderCommit, matched);
      applyCommitted();
    }
    return { term: currentTerm, success: true, matchIndex: matched };
  });

  void loaded.then(() => {
    if (alive) resetElectionTimer(); // everyone starts as a follower waiting for a leader
  });

  return {
    propose(command) {
      if (role !== 'leader') {
        return Promise.reject(
          new Failure(NOT_LEADER, `${self} is not the leader`, { leader: leaderId }),
        );
      }
      log.push({ term: currentTerm, command });
      const index = lastLogIndex();
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(index, { term: currentTerm, resolve, reject });
      });
      void persist().then(() => {
        advanceCommit(); // a single-member group commits right here
        void Promise.all(others.map(replicateTo));
      });
      return result;
    },
    role: () => role,
    leader: () => leaderId,
    term: () => currentTerm,
    state: () => state,
    committedIndex: () => commitIndex,
    stop() {
      alive = false;
      if (electionTimer) clearTimeout(electionTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      for (const [index, waiter] of [...pending]) {
        pending.delete(index);
        waiter.reject(new Failure(NOT_LEADER, 'member stopped', { leader: null }));
      }
    },
  };
}
