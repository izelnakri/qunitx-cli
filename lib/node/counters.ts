/**
 * Convergent counters and a register map — the companions to the {@link ORSet}: riak_dt's
 * `emcntr`/LWW-register family, sized for distributed metrics, quotas, and settings. Each replica
 * mutates locally with no coordination; `merge` any two states in any order and every replica
 * converges. Ship states over anything — a CRDT frame, anti-entropy, a store.
 *
 *  - {@link GCounter} — grow-only: cluster-wide totals (requests served, messages seen).
 *  - {@link PNCounter} — increment/decrement: live gauges (connections open, jobs in flight).
 *  - {@link LWWMap} — last-writer-wins register map: distributed settings/config, where the
 *    newest write per key wins deterministically (timestamp, then replica id as tiebreak).
 *
 * ```ts
 * const a = new GCounter('a@n');
 * const b = new GCounter('b@n');
 * a.increment(2);
 * b.increment(3);
 * a.merge(b.state());
 * a.value(); // 5 — the cluster-wide total
 * ```
 */

/** A grow-only counter's replicated state: highest count per replica. */
export type GCounterState = Record<string, number>;

/**
 * A grow-only counter (riak_dt's `gcounter`): each replica owns its own slot and only raises it;
 * `value` is the sum of every slot, `merge` is a pointwise max — commutative, idempotent.
 *
 * ```ts
 * const c = new GCounter('n@1');
 * c.increment();
 * c.value(); // 1
 * ```
 */
export class GCounter {
  #node: string;
  #counts: GCounterState = {};

  /** `node` names this replica's slot. */
  constructor(node: string) {
    this.#node = node;
  }

  /**
   * Add `n` (default 1, must be ≥ 0 — a G-counter never shrinks) to this replica's slot.
   *
   * ```ts
   * const c = new GCounter('n@1');
   * c.increment(5);
   * c.value(); // 5
   * ```
   */
  increment(n = 1): void {
    if (n < 0) throw new RangeError('a GCounter only grows — use PNCounter to decrement');
    this.#counts[this.#node] = (this.#counts[this.#node] ?? 0) + n;
  }

  /**
   * The cluster-wide total: the sum of every replica's slot.
   *
   * ```ts
   * new GCounter('n@1').value(); // 0
   * ```
   */
  value(): number {
    return Object.values(this.#counts).reduce((sum, n) => sum + n, 0);
  }

  /**
   * The replicated state — hand to a peer to merge.
   *
   * ```ts
   * const c = new GCounter('n@1');
   * c.increment(2);
   * c.state(); // { 'n@1': 2 }
   * ```
   */
  state(): GCounterState {
    return { ...this.#counts };
  }

  /**
   * Pointwise max with a peer's state — any order, any repetition converges.
   *
   * ```ts
   * const a = new GCounter('a@n');
   * a.merge({ 'b@n': 3 });
   * a.value(); // 3
   * ```
   */
  merge(other: GCounterState): void {
    for (const node in other) {
      this.#counts[node] = Math.max(this.#counts[node] ?? 0, other[node]);
    }
  }
}

/** A PN-counter's replicated state: one grow-only side for increments, one for decrements. */
export interface PNCounterState {
  /** Increments per replica. */
  p: GCounterState;
  /** Decrements per replica. */
  n: GCounterState;
}

/**
 * An increment/decrement counter (riak_dt's `pncounter`): two G-counters, `value` = P − N. The
 * live-gauge CRDT — connections open, jobs in flight — convergent under any merge order.
 *
 * ```ts
 * const c = new PNCounter('n@1');
 * c.increment(3);
 * c.decrement();
 * c.value(); // 2
 * ```
 */
export class PNCounter {
  #p: GCounter;
  #n: GCounter;

  /** `node` names this replica's slots. */
  constructor(node: string) {
    this.#p = new GCounter(node);
    this.#n = new GCounter(node);
  }

  /**
   * Raise the gauge by `n` (default 1).
   *
   * ```ts
   * const c = new PNCounter('n@1');
   * c.increment(2);
   * c.value(); // 2
   * ```
   */
  increment(n = 1): void {
    this.#p.increment(n);
  }

  /**
   * Lower the gauge by `n` (default 1) — may go negative, as with a gauge that closes more than
   * this replica opened.
   *
   * ```ts
   * const c = new PNCounter('n@1');
   * c.decrement();
   * c.value(); // -1
   * ```
   */
  decrement(n = 1): void {
    this.#n.increment(n);
  }

  /**
   * The converged gauge: total increments minus total decrements.
   *
   * ```ts
   * new PNCounter('n@1').value(); // 0
   * ```
   */
  value(): number {
    return this.#p.value() - this.#n.value();
  }

  /**
   * The replicated state — both sides.
   *
   * ```ts
   * const c = new PNCounter('n@1');
   * c.increment();
   * c.state().p; // { 'n@1': 1 }
   * ```
   */
  state(): PNCounterState {
    return { p: this.#p.state(), n: this.#n.state() };
  }

  /**
   * Merge a peer's state — each side is a pointwise max.
   *
   * ```ts
   * const a = new PNCounter('a@n');
   * a.merge({ p: { 'b@n': 5 }, n: { 'b@n': 2 } });
   * a.value(); // 3
   * ```
   */
  merge(other: PNCounterState): void {
    this.#p.merge(other.p);
    this.#n.merge(other.n);
  }
}

/** One LWW register: the value plus the write stamp that decides conflicts. */
export interface LWWEntry<V> {
  /** The written value. */
  value: V;
  /** The write's timestamp — newest wins. */
  at: number;
  /** The writing replica — deterministic tiebreak when timestamps collide. */
  by: string;
}

/** An LWW map's replicated state: every key's winning register. */
export type LWWMapState<V> = Record<string, LWWEntry<V>>;

/**
 * A last-writer-wins register map (riak_dt's LWW-register, keyed): concurrent writes to a key
 * resolve deterministically — newer timestamp wins, replica id breaks exact ties — so every node
 * converges on the same value per key. The distributed-settings CRDT: feature flags, per-tenant
 * config, rate-limit overrides.
 *
 * ```ts
 * const a = new LWWMap<string>('a@n');
 * const b = new LWWMap<string>('b@n');
 * a.set('theme', 'dark', 100);
 * b.set('theme', 'light', 200); // later write
 * a.merge(b.state());
 * a.get('theme'); // 'light' — the newest write won everywhere
 * ```
 */
export class LWWMap<V> {
  #node: string;
  #entries: LWWMapState<V> = {};

  /** `node` identifies this replica's writes (the tiebreak). */
  constructor(node: string) {
    this.#node = node;
  }

  #wins(candidate: LWWEntry<V>, incumbent: LWWEntry<V> | undefined): boolean {
    if (!incumbent) return true;
    if (candidate.at !== incumbent.at) return candidate.at > incumbent.at;
    return candidate.by > incumbent.by; // deterministic tiebreak on equal stamps
  }

  /**
   * Write `key` = `value`. `at` defaults to `Date.now()`; pass explicitly for deterministic tests.
   *
   * ```ts
   * const m = new LWWMap<number>('n@1');
   * m.set('limit', 10, 1);
   * m.get('limit'); // 10
   * ```
   */
  set(key: string, value: V, at = Date.now()): void {
    const entry: LWWEntry<V> = { value, at, by: this.#node };
    if (this.#wins(entry, this.#entries[key])) this.#entries[key] = entry;
  }

  /**
   * The current winning value for `key`, or undefined.
   *
   * ```ts
   * new LWWMap<number>('n@1').get('nope'); // undefined
   * ```
   */
  get(key: string): V | undefined {
    return this.#entries[key]?.value;
  }

  /**
   * Every key with a winning register.
   *
   * ```ts
   * const m = new LWWMap<number>('n@1');
   * m.set('a', 1, 1);
   * m.keys(); // ['a']
   * ```
   */
  keys(): string[] {
    return Object.keys(this.#entries);
  }

  /**
   * The replicated state — hand to a peer to merge.
   *
   * ```ts
   * const m = new LWWMap<number>('n@1');
   * m.set('a', 1, 7);
   * m.state().a.at; // 7
   * ```
   */
  state(): LWWMapState<V> {
    return { ...this.#entries };
  }

  /**
   * Merge a peer's state: per key, the newer (or tiebroken) register wins — convergent in any
   * order.
   *
   * ```ts
   * const a = new LWWMap<string>('a@n');
   * a.merge({ k: { value: 'x', at: 5, by: 'b@n' } });
   * a.get('k'); // 'x'
   * ```
   */
  merge(other: LWWMapState<V>): void {
    for (const key in other) {
      if (this.#wins(other[key], this.#entries[key])) this.#entries[key] = other[key];
    }
  }
}
