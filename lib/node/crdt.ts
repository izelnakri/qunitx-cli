/**
 * A convergent replicated set — an **ORSWOT** (Observed-Remove Set Without Tombstones), the
 * design riak_dt and Elixir's DeltaCrdt use, and the convergence core of a Horde-style registry.
 * Elements can be added and removed concurrently on any node, and every node **converges to the
 * same set** after anti-entropy — even if messages were dropped or the cluster partitioned and
 * healed. Plain fire-and-forget gossip cannot promise this: a lost `join`/`register` stays lost
 * until a reconnect, and a partition never reconciles. The merge is commutative, associative,
 * and idempotent, so order and duplication don't matter.
 *
 * How it works without unbounded tombstones: each add stamps the element with a unique **dot**
 * `${node}:${counter}`, and a compact per-node **causal context** (a version vector) records the
 * highest counter *ever seen* from each node. An element is present iff it holds a live dot. On
 * merge, a dot the peer has *seen* (≤ its context) but no longer holds was removed by the peer,
 * so it's dropped; a dot the peer has *never seen* is a concurrent add and **survives** a stale
 * remove (add-wins). The context is a version vector, so state stays small — no tombstone list.
 *
 * ```ts
 * const a = new ORSet('a@n');
 * const b = new ORSet('b@n');
 * a.add('lobby');
 * b.merge(a.state()); // anti-entropy
 * b.has('lobby'); // true — converged
 * ```
 */

/** A unique stamp per add — `${node}:${counter}`. */
export type Dot = string;
/** Highest counter observed per node — the causal context; also gates no-op syncs. */
export type VersionVector = Record<string, number>;
/** The wire form of an ORSet — its live dots per element plus the causal context. */
export interface CrdtState {
  /** Each present element with its live dots. */
  dots: [element: string, dots: Dot[]][];
  /** The causal context — highest counter seen per node. */
  context: VersionVector;
}

const dotNode = (dot: Dot): string => dot.slice(0, dot.lastIndexOf(':'));
const dotCount = (dot: Dot): number => Number(dot.slice(dot.lastIndexOf(':') + 1));
const seen = (dot: Dot, context: VersionVector): boolean =>
  dotCount(dot) <= (context[dotNode(dot)] ?? 0);

/**
 * A convergent replicated set (ORSWOT). See the module overview for the algorithm.
 *
 * ```ts
 * const s = new ORSet('n@1');
 * s.add('a');
 * s.has('a'); // true
 * ```
 */
export class ORSet {
  #node: string;
  #dots = new Map<string, Set<Dot>>(); // element -> its live dots
  #context: VersionVector = {}; // highest counter ever seen per node

  /** `node` is this replica's id — it stamps the dots this node mints, so they stay unique. */
  constructor(node: string) {
    this.#node = node;
  }

  #freshDot(): Dot {
    const counter = (this.#context[this.#node] ?? 0) + 1;
    this.#context[this.#node] = counter;
    return `${this.#node}:${counter}`;
  }

  /**
   * Add `element`, stamping it with a fresh dot.
   *
   * ```ts
   * const s = new ORSet('n@1');
   * s.add('room');
   * s.values(); // ['room']
   * ```
   */
  add(element: string): void {
    if (!this.#dots.has(element)) this.#dots.set(element, new Set());
    this.#dots.get(element)!.add(this.#freshDot());
  }

  /**
   * Observed-remove: drop `element`'s live dots. A concurrent add elsewhere (a dot never seen
   * here) survives the merge — add-wins.
   *
   * ```ts
   * const s = new ORSet('n@1');
   * s.add('room');
   * s.remove('room');
   * s.has('room'); // false
   * ```
   */
  remove(element: string): void {
    this.#dots.delete(element);
  }

  /**
   * Whether `element` currently has a live dot.
   *
   * ```ts
   * new ORSet('n@1').has('nope'); // false
   * ```
   */
  has(element: string): boolean {
    return this.#dots.has(element);
  }

  /**
   * Every present element.
   *
   * ```ts
   * const s = new ORSet('n@1');
   * s.add('x');
   * s.values(); // ['x']
   * ```
   */
  values(): string[] {
    return [...this.#dots.keys()];
  }

  /**
   * This node's causal context — hand to a peer to let it skip a no-op sync via {@link ORSet.dominates}.
   *
   * ```ts
   * const s = new ORSet('n@1');
   * s.add('x');
   * s.versionVector(); // { 'n@1': 1 }
   * ```
   */
  versionVector(): VersionVector {
    return { ...this.#context };
  }

  /**
   * Whether this node has already seen everything in `vv` (so a sync from it would be a no-op).
   *
   * ```ts
   * const a = new ORSet('a@n');
   * a.add('x');
   * a.dominates({ 'a@n': 1 }); // true
   * a.dominates({ 'b@n': 5 }); // false
   * ```
   */
  dominates(vv: VersionVector): boolean {
    for (const node in vv) if ((this.#context[node] ?? 0) < vv[node]) return false;
    return true;
  }

  /**
   * The full replicated state for anti-entropy — merge it into a peer to converge.
   *
   * ```ts
   * const s = new ORSet('n@1');
   * s.add('x');
   * s.state().dots; // [['x', ['n@1:1']]]
   * ```
   */
  state(): CrdtState {
    return {
      dots: [...this.#dots].map(([element, dots]) => [element, [...dots]]),
      context: { ...this.#context },
    };
  }

  /**
   * A one-element delta for broadcasting a single op (O(1), not O(keys) like {@link ORSet.state}).
   * Carries the element's current live dots (empty if it was just removed) plus the full context;
   * apply with {@link ORSet.mergeDelta}. This is how a `join`/`register` propagates immediately
   * without shipping the whole set — anti-entropy (full `state`) still backstops any loss.
   *
   * ```ts
   * const s = new ORSet('n@1');
   * s.add('x');
   * s.delta('x').dots; // [['x', ['n@1:1']]]
   * ```
   */
  delta(element: string): CrdtState {
    const dots = this.#dots.get(element);
    return { dots: [[element, dots ? [...dots] : []]], context: { ...this.#context } };
  }

  /**
   * Merge a {@link ORSet.delta} — reconciles ONLY the elements it names (a partial update),
   * unlike {@link ORSet.merge}, which reconciles the union and so treats an absent element as a
   * remove. Use this for per-op broadcasts; use `merge` for full-state anti-entropy.
   *
   * ```ts
   * const a = new ORSet('a@n');
   * const b = new ORSet('b@n');
   * b.add('keep');
   * a.add('x');
   * b.mergeDelta(a.delta('x'));
   * b.values().sort(); // ['keep', 'x'] — 'keep' was NOT dropped
   * ```
   */
  mergeDelta(delta: CrdtState): void {
    this.#reconcile(
      delta.dots.map(([element]) => element),
      delta,
    );
  }

  /**
   * Merge a peer's {@link CrdtState} (ORSWOT merge) — commutative/idempotent, any order converges.
   *
   * ```ts
   * const a = new ORSet('a@n');
   * const b = new ORSet('b@n');
   * a.add('x');
   * b.merge(a.state());
   * b.has('x'); // true
   * ```
   */
  merge(other: CrdtState): void {
    this.#reconcile([...this.#dots.keys(), ...other.dots.map(([element]) => element)], other);
  }

  // The ORSWOT merge over a given element set — the union (full merge) or a delta's elements.
  #reconcile(elements: Iterable<string>, other: CrdtState): void {
    const theirDots = new Map(other.dots.map(([element, dots]) => [element, new Set(dots)]));
    for (const element of new Set(elements)) {
      const mine = this.#dots.get(element) ?? new Set<Dot>();
      const theirs = theirDots.get(element) ?? new Set<Dot>();
      const live = new Set<Dot>();
      // Keep my dot if the peer also holds it, or the peer has never seen it (so can't have removed it).
      for (const dot of mine) if (theirs.has(dot) || !seen(dot, other.context)) live.add(dot);
      // Add the peer's dots I have never seen (concurrent adds).
      for (const dot of theirs) if (!seen(dot, this.#context)) live.add(dot);
      if (live.size > 0) this.#dots.set(element, live);
      else this.#dots.delete(element);
    }
    for (const node in other.context) {
      this.#context[node] = Math.max(this.#context[node] ?? 0, other.context[node]);
    }
  }
}
