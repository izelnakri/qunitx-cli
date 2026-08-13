// Event sourcing over a Store — Elixir's Commanded/EventStore pattern, minimal and correct. Instead
// of persisting a snapshot of state (what genServer's `store` does), an aggregate persists the
// append-only LOG of events; state is a deterministic fold over that log. The log is the source of
// truth: on restart the aggregate rebuilds state by replaying it (from the latest snapshot forward,
// so replay stays bounded). Events are immutable — there is no delete, by design. Universal: needs
// only a Store with `keys()` (memory/file/postgres/raft all qualify).
import type { Store } from './store.ts';

/**
 * The pure heart of an event-sourced aggregate. `decide` turns a command into zero or more events
 * (the business rule — validate here, emit nothing to reject); `apply` folds an event into state
 * (the projection). BOTH must be deterministic and side-effect-free: `apply` replays historical
 * events on every restart, and must produce the identical state each time.
 */
export interface Aggregate<S, C = unknown, E = unknown> {
  /** The empty state, before any event. */
  init: () => S;
  /** Command → events. Emit `[]` to reject/no-op; the events are what get persisted. */
  decide: (state: S, command: C) => E[];
  /** Fold one event into state — the projection, replayed verbatim on restart. */
  apply: (state: S, event: E) => S;
}

/** A running event-sourced aggregate — {@link eventSourced} returns one. */
export interface EventSourced<S, C, E> {
  /** Run a command: `decide` → persist the events → fold them in. Returns the emitted events.
   *  Serialized, so concurrent calls can't interleave a decide against a half-applied log. */
  execute(command: C): Promise<E[]>;
  /** The current folded state (after `ready()`). */
  state(): S;
  /** Resolves once the persisted log has replayed and the aggregate is ready to accept commands. */
  ready(): Promise<void>;
  /** How many events have been committed (the log length). */
  version(): number;
}

/**
 * Boot an event-sourced aggregate named `name`, backed by `options.store`. It replays its persisted
 * event log to rebuild state, then accepts commands: each `execute` decides events, appends them
 * durably (one key per event — O(1) append, no rewrite), and folds them in. Pass `snapshotEvery` to
 * checkpoint state every N events so replay after a restart stays bounded.
 *
 * ```ts
 * import { memoryStore } from './store.ts';
 *
 * type Account = { balance: number };
 * const bank = eventSourced<Account, { deposit: number }, { credited: number }>('acct', {
 *   init: () => ({ balance: 0 }),
 *   decide: (_s, c) => (c.deposit > 0 ? [{ credited: c.deposit }] : []),
 *   apply: (s, e) => ({ balance: s.balance + e.credited }),
 * }, { store: memoryStore() });
 *
 * await bank.execute({ deposit: 100 });
 * await bank.execute({ deposit: 50 });
 * bank.state().balance; // 150
 * bank.version(); // 2
 * ```
 */
export function eventSourced<S, C = unknown, E = unknown>(
  name: string,
  aggregate: Aggregate<S, C, E>,
  options: { store: Store; snapshotEvery?: number },
): EventSourced<S, C, E> {
  const store = options.store;
  if (!store.keys) throw new Error(`eventSourced(${name}) needs a Store that implements keys()`);
  const eventPrefix = `${name}::e`; // per-event keys: `${name}::e<seq>`
  const snapshotKey = `${name}::snap`; // { seq, state }
  const eventKey = (seq: number): string => `${eventPrefix}${seq}`;

  let state = aggregate.init();
  let seq = 0; // the last committed event's 1-based sequence number (== log length)
  let chain: Promise<unknown> = Promise.resolve(); // serialization lock for execute

  const replay = (async () => {
    const snap = (await store.load(snapshotKey)) as { seq: number; state: S } | undefined;
    if (snap) {
      state = snap.state;
      seq = snap.seq;
    }
    const keys = await store.keys!(eventPrefix);
    const pending = keys
      .map((k) => Number(k.slice(eventPrefix.length)))
      .filter((n) => Number.isFinite(n) && n > seq)
      .sort((a, b) => a - b);
    for (const n of pending) {
      state = aggregate.apply(state, (await store.load(eventKey(n))) as E);
      seq = n;
    }
  })();

  const commit = async (command: C): Promise<E[]> => {
    await replay;
    const events = aggregate.decide(state, command);
    for (const event of events) {
      seq += 1;
      await store.save(eventKey(seq), event); // durable BEFORE it is folded in — no phantom state
      state = aggregate.apply(state, event);
      if (options.snapshotEvery && seq % options.snapshotEvery === 0)
        await store.save(snapshotKey, { seq, state });
    }
    return events;
  };

  return {
    execute(command) {
      // Chain onto the lock so decisions serialize; failures don't wedge the chain for the next call.
      const result = chain.then(() => commit(command));
      chain = result.catch(() => {});
      return result;
    },
    state: () => state,
    ready: () => replay,
    version: () => seq,
  };
}
