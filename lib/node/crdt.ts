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
 * `${node}:${counter}`, and a compact **causal context** records which dots have been observed.
 * The context is a version vector (a contiguous `counter` prefix per node) plus a small **dot
 * cloud** — the dots seen *above* that prefix, before the gap between them is filled. An element
 * is present iff it holds a live dot. On merge, a dot the peer has *seen* (in its context) but no
 * longer holds was removed by the peer, so it's dropped; a dot the peer has *never seen* is a
 * concurrent add and **survives** a stale remove (add-wins).
 *
 * The dot cloud is what makes per-op **deltas** safe: a delta carries only its own dots (not the
 * sender's whole context), so a receiver that missed an earlier op never *falsely* records the
 * gap as seen — which would make a later full-state merge read the gap as a remove and delete a
 * live entry. The version vector only advances over a contiguous run; out-of-order dots wait in
 * the cloud until the gap fills, then compact away, so state stays small.
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
/** Highest CONTIGUOUS counter observed per node — the version-vector prefix of a causal context. */
export type VersionVector = Record<string, number>;
/** What dots have been observed: a contiguous version vector plus the out-of-order dots above it. */
export interface CausalContext {
  /** Contiguous counter prefix per node — every dot `node:1..counter` has been seen. */
  vv: VersionVector;
  /** Dots seen ABOVE the contiguous prefix (a gap is unfilled); compact into `vv` as gaps close. */
  cloud: Dot[];
}
/** The wire form of an ORSet — its live dots per element plus the causal context. */
export interface CrdtState {
  /** Each present element with its live dots. */
  dots: [element: string, dots: Dot[]][];
  /** The causal context — which dots have been observed. */
  context: CausalContext;
}

const dotNode = (dot: Dot): string => dot.slice(0, dot.lastIndexOf(':'));
const dotCount = (dot: Dot): number => Number(dot.slice(dot.lastIndexOf(':') + 1));

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
  #vv: VersionVector = {}; // contiguous counter prefix per node
  #cloud = new Set<Dot>(); // dots seen above the prefix (a gap not yet filled)

  /** `node` is this replica's id — it stamps the dots this node mints, so they stay unique. */
  constructor(node: string) {
    this.#node = node;
  }

  // A dot is observed iff it is under this node's contiguous prefix or sits in the cloud.
  #seen(dot: Dot): boolean {
    return dotCount(dot) <= (this.#vv[dotNode(dot)] ?? 0) || this.#cloud.has(dot);
  }

  #freshDot(): Dot {
    // Own dots are minted sequentially, so they always extend the contiguous prefix directly.
    const counter = (this.#vv[this.#node] ?? 0) + 1;
    this.#vv[this.#node] = counter;
    return `${this.#node}:${counter}`;
  }

  /**
   * Add `element`, stamping it with a fresh dot; returns the one-op {@link CrdtState} delta to
   * broadcast (carrying only this dot, so it can't poison a peer's context — see the overview).
   *
   * ```ts
   * const s = new ORSet('n@1');
   * s.add('room');
   * s.values(); // ['room']
   * ```
   */
  add(element: string): CrdtState {
    const dot = this.#freshDot();
    if (!this.#dots.has(element)) this.#dots.set(element, new Set());
    this.#dots.get(element)!.add(dot);
    return { dots: [[element, [dot]]], context: { vv: {}, cloud: [dot] } };
  }

  /**
   * Observed-remove: drop `element`'s live dots; returns the delta to broadcast (empty dots plus
   * the removed dots as context, so peers learn the removal). A concurrent add elsewhere (a dot
   * never seen here) survives the merge — add-wins.
   *
   * ```ts
   * const s = new ORSet('n@1');
   * s.add('room');
   * s.remove('room');
   * s.has('room'); // false
   * ```
   */
  remove(element: string): CrdtState {
    const removed = this.#dots.get(element);
    const dots = removed ? [...removed] : [];
    this.#dots.delete(element);
    return { dots: [[element, []]], context: { vv: {}, cloud: dots } };
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
   * This node's version vector (the contiguous prefix of its causal context) — a coarse
   * "how far along am I" summary; {@link ORSet.context} is the exact form for a sync request.
   *
   * ```ts
   * const s = new ORSet('n@1');
   * s.add('x');
   * s.versionVector(); // { 'n@1': 1 }
   * ```
   */
  versionVector(): VersionVector {
    return { ...this.#vv };
  }

  /**
   * This node's full causal context — hand to a peer so it can reply with only what you're
   * missing (see {@link ORSet.hasBeyond}).
   *
   * ```ts
   * const s = new ORSet('n@1');
   * s.add('x');
   * s.context(); // { vv: { 'n@1': 1 }, cloud: [] }
   * ```
   */
  context(): CausalContext {
    return { vv: { ...this.#vv }, cloud: [...this.#cloud] };
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
    for (const node in vv) if ((this.#vv[node] ?? 0) < vv[node]) return false;
    return true;
  }

  /**
   * Whether this node knows anything the causal context `cc` does not — a live dot `cc` hasn't
   * seen, or an op (add or remove) beyond it. This is the anti-entropy reply test: answer a sync
   * with full state iff `hasBeyond(theirContext)` (otherwise the reply would be a no-op).
   *
   * ```ts
   * const a = new ORSet('a@n');
   * a.add('x');
   * a.hasBeyond({ vv: {}, cloud: [] }); // true — a peer with nothing is behind
   * a.hasBeyond(a.context()); // false — nothing beyond my own context
   * ```
   */
  hasBeyond(cc: CausalContext): boolean {
    const cloud = new Set(cc.cloud);
    const ccSeen = (dot: Dot): boolean =>
      dotCount(dot) <= (cc.vv[dotNode(dot)] ?? 0) || cloud.has(dot);
    for (const dots of this.#dots.values()) for (const dot of dots) if (!ccSeen(dot)) return true;
    for (const node in this.#vv) if (this.#vv[node] > (cc.vv[node] ?? 0)) return true;
    for (const dot of this.#cloud) if (!ccSeen(dot)) return true;
    return false;
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
      context: this.context(),
    };
  }

  /**
   * Merge a one-op delta from {@link ORSet.add}/{@link ORSet.remove} — reconciles ONLY the
   * elements it names (a partial update), unlike {@link ORSet.merge}, which reconciles the union
   * and so treats an absent element as a remove. Use this for per-op broadcasts; use `merge` for
   * full-state anti-entropy.
   *
   * ```ts
   * const a = new ORSet('a@n');
   * const b = new ORSet('b@n');
   * b.add('keep');
   * const delta = a.add('x');
   * b.mergeDelta(delta);
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
   * Merge a peer's full {@link CrdtState} (ORSWOT merge) — commutative/idempotent, any order converges.
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
    const theirCloud = new Set(other.context.cloud);
    const theirSeen = (dot: Dot): boolean =>
      dotCount(dot) <= (other.context.vv[dotNode(dot)] ?? 0) || theirCloud.has(dot);
    const theirDots = new Map(other.dots.map(([element, dots]) => [element, new Set(dots)]));
    for (const element of new Set(elements)) {
      const mine = this.#dots.get(element) ?? new Set<Dot>();
      const theirs = theirDots.get(element) ?? new Set<Dot>();
      const live = new Set<Dot>();
      // Keep my dot if the peer also holds it, or the peer has never seen it (so can't have removed it).
      for (const dot of mine) if (theirs.has(dot) || !theirSeen(dot)) live.add(dot);
      // Add the peer's dots I have never seen (concurrent adds).
      for (const dot of theirs) if (!this.#seen(dot)) live.add(dot);
      if (live.size > 0) this.#dots.set(element, live);
      else this.#dots.delete(element);
    }
    this.#mergeContext(other.context);
  }

  // Join causal contexts: version vectors pointwise-max, dot clouds union, then compact any
  // now-contiguous cloud dots down into the version vector so the cloud stays small.
  #mergeContext(other: CausalContext): void {
    for (const node in other.vv) this.#vv[node] = Math.max(this.#vv[node] ?? 0, other.vv[node]);
    for (const dot of other.cloud) this.#cloud.add(dot);
    const nodes = new Set<string>();
    for (const dot of this.#cloud) nodes.add(dotNode(dot));
    for (const node of nodes) {
      let next = (this.#vv[node] ?? 0) + 1;
      while (this.#cloud.has(`${node}:${next}`)) this.#cloud.delete(`${node}:${next++}`);
      this.#vv[node] = next - 1;
    }
  }
}
