// Elixir's `Process` module, JS-shaped: the process operations that are NOT about an existing
// `self`. `spawn` CREATES a process — a bare function (`spawn(fun)` / `spawn(mod, fun, args)`) or a
// gen_server (`spawn(behavior)`) — so it can't hang off a self. The free-function forms
// (`link`/`exit`/`alive`) mirror Elixir's `Process.link(pid)` / `Process.exit(pid, reason)` /
// `Process.alive?(pid)` for callers who hold a handle. Bound-to-self ops live on the handle itself
// (`unit.cast`, `unit.exit`, …) and on the `self` a handler receives — this module is the static side.
import type { Any as AnyFailure } from '../result/failure.ts';
import {
  genServer,
  spawnProcess,
  type Behavior,
  type GenServer,
  type GenServerOptions,
  type Pid,
} from './gen-server.ts';
import { yieldToLoop } from './scheduler.ts';
import type { NodeHandle } from './node.ts';

// The minimal handle shape the free functions touch — picked so ANY GenServer<S, K> qualifies
// regardless of its state/key types (none of these members mention S or K).
type Unit = Pick<GenServer<unknown, string>, 'link' | 'exit' | 'isAlive'>;

/**
 * The {@link Process} module with one node pre-applied — what {@link Process.of} returns. The
 * node-first functions (`spawn`/`whereis`/`list`/`whereisName`) drop their `node` argument;
 * `link`/`exit`/`alive` operate on handles, so they pass through unchanged.
 */
export interface BoundProcess {
  /** {@link Process.spawn} of a gen_server, on the bound node. */
  spawn<S, K extends string = string>(
    behavior: Behavior<S, K>,
    options?: GenServerOptions,
  ): GenServer<S, K>;
  /** {@link Process.spawn} of a bare function (Erlang `spawn/1,2`), on the bound node. */
  spawn(fun: (self: Pid) => void | Promise<void>, options?: { link?: object }): Pid;
  /** {@link Process.spawn} of a module function (Erlang `spawn/3,4`), on the bound node. */
  spawn(mod: object, fun: string, args?: unknown[], options?: { link?: object }): Pid;
  /** {@link Process.link} — handle-based, unchanged. */
  link(a: Unit, b: object): void;
  /** {@link Process.exit} — handle-based, unchanged. */
  exit(unit: Unit, reason?: AnyFailure): void;
  /** {@link Process.alive} — handle-based, unchanged. */
  alive(unit: Unit): boolean;
  /** {@link Process.whereis} on the bound node. */
  whereis(name: string): string | null;
  /** {@link Process.list} on the bound node. */
  list(): string[];
  /** {@link Process.whereisName} on the bound node. */
  whereisName(registry: string, key: string): string | null;
  /** {@link Process.yield} — node-independent, unchanged. */
  yield(): Promise<void>;
}

// Monotonic across the process — anonymous names only need to be unique, and the node prefix keeps
// them readable/attributable. Not Math.random/Date.now (a counter is enough and stays deterministic).
// A BigInt so the sequence has NO ceiling: `number` would exhaust safe integers at 2^53 (~285 years
// at 1M spawns/s, but a hard limit); BigInt removes it outright for a long-lived, high-churn runtime.
let spawnCount = 0n;

/**
 * Elixir's `Process` module — the static side of process management, the operations that aren't a
 * method on some existing `self`:
 *
 * - `spawn` CREATES a process, auto-named (no name to invent). Give it a **function** for a bare
 *   process (Erlang `spawn/1`: runs to completion, no mailbox) — `Process.spawn(node, (self) => …)`
 *   or the module form `Process.spawn(node, mod, 'fn', [args])` — or a **behavior** for an anonymous
 *   {@link genServer} (a process WITH a mailbox). Returns a {@link Pid} or a {@link GenServer}.
 * - `link` / `exit` / `alive` are the free-function forms of Elixir's `Process.link(pid)` /
 *   `Process.exit(pid, reason)` / `Process.alive?(pid)`, for code that holds a handle.
 * - `whereis` / `list` read the LOCAL process table — units served on THIS node (Elixir's
 *   `Process.whereis/1` and `Process.registered/0`). `whereisName` is the cluster lookup
 *   (`:global.whereis_name` / a Registry): which node hosts a via-registered key.
 * - `of(node)` binds all of the above to one node, recovering Elixir's node-free feel (there is no
 *   ambient "current node" here — many nodes share one process — so `of` is how you pick one).
 *
 * ```ts
 * import { Node, memoryHub } from './node.ts';
 * import { Process } from './process.ts';
 *
 * const node = Node.start('a@proc', memoryHub().transport());
 * const counter = Process.spawn(node, {
 *   version: '1',
 *   init: () => 0,
 *   handlers: { bump: (n) => ({ state: n + 1, reply: n + 1 }) },
 * });
 * await counter.call('bump'); // 1 — addressed by the handle, no name to pick
 * Process.alive(counter); // true
 * Process.list(node).length; // 1 — one unit served here
 *
 * const proc = Process.spawn(node, () => {}); // a BARE process — Erlang spawn/1
 * typeof proc.name; // 'string'
 *
 * // Or bind the node once and drop the repeated argument:
 * const P = Process.of(node);
 * P.list().length; // 1 — same table, node-free
 * Process.exit(counter);
 * P.list().length; // 0 — a dead unit leaves the local table
 * node.stop();
 * ```
 *
 * - `yield()` cooperatively hands the event loop back mid-handler — BEAM preempts a long computation
 *   for you; here you spend a reduction voluntarily inside a big loop so the node stays responsive
 *   (`if (++done % 500 === 0) await Process.yield()`).
 */
export const Process = {
  spawn,
  link,
  exit,
  alive,
  whereis,
  whereisName,
  list,
  of,
  /** Cooperative yield inside a long handler loop — see {@link BoundProcess.yield}. */
  yield: yieldToLoop,
};

/**
 * Spawn an anonymous process on `node`, auto-named `<node>:proc:<n>`, addressed by the returned
 * handle — Elixir's `spawn`. A **behavior** starts a gen_server (a {@link GenServer}, mailbox +
 * handlers); a **function** starts a bare process (a {@link Pid}: runs `fun(self)` to completion,
 * no mailbox); `(mod, 'fn', args)` is the module form, sugar for `spawn(node, (self) => mod.fn(self,
 * …args))`. `{ link }` links it on spawn (Erlang `spawn_link`); pass `{ via }` on a behavior to make
 * it name-reachable.
 */
function spawn<S, K extends string = string>(
  node: NodeHandle,
  behavior: Behavior<S, K>,
  options?: GenServerOptions,
): GenServer<S, K>;
function spawn(
  node: NodeHandle,
  fun: (self: Pid) => void | Promise<void>,
  options?: { link?: object },
): Pid;
function spawn(
  node: NodeHandle,
  mod: object,
  fun: string,
  args?: unknown[],
  options?: { link?: object },
): Pid;
function spawn(
  node: NodeHandle,
  second: unknown,
  third?: unknown,
  fourth?: unknown,
  fifth?: unknown,
): GenServer<unknown> | Pid {
  spawnCount += 1n;
  const name = `${node.self()}:proc:${spawnCount}`;
  if (typeof second === 'function') {
    return spawnProcess(
      node,
      name,
      second as (self: Pid) => void | Promise<void>,
      third as { link?: object },
    );
  }
  if (typeof third === 'string') {
    // MFA (Erlang spawn/3,4): mod[fun](self, ...args). Sugar over the function form.
    const mod = second as Record<string, (self: Pid, ...args: unknown[]) => void | Promise<void>>;
    const args = (fourth as unknown[]) ?? [];
    return spawnProcess(
      node,
      name,
      (self) => mod[third](self, ...args),
      fifth as { link?: object },
    );
  }
  return genServer(node, name, second as Behavior<unknown>, third as GenServerOptions);
}

/** `Process.link(pid)` — link two units bidirectionally; an exit in either propagates to the other. */
function link(a: Unit, b: object): void {
  a.link(b);
}

/** `Process.exit(pid, reason)` — terminate `unit` (propagates to its links; a supervisor restarts). */
function exit(unit: Unit, reason?: AnyFailure): void {
  unit.exit(reason);
}

/** `Process.alive?(pid)` — whether `unit` still serves. */
function alive(unit: Unit): boolean {
  return unit.isAlive();
}

/**
 * Elixir's `Process.whereis(name)` — the LOCAL lookup: is a unit named `name` alive on THIS node?
 * Returns the node's own name (its "address") if so, else `null`. Reads the local-unit table, so it
 * is a synchronous, in-process answer — no wire hop, unlike {@link whereisName}.
 */
function whereis(node: NodeHandle, name: string): string | null {
  return node.unit(name) ? node.self() : null;
}

/** Elixir's `Process.registered/0` — the names of every unit served locally on `node` right now. */
function list(node: NodeHandle): string[] {
  return node.units();
}

/**
 * Look a registered name up across the CLUSTER — Elixir's `:global.whereis_name` / a `Registry`
 * lookup: the node that currently hosts `key` in `registry`, or `null` if none. Works for units
 * registered with `{ via: { registry, key } }`. Contrast {@link whereis}, which is local-only.
 */
function whereisName(node: NodeHandle, registry: string, key: string): string | null {
  return node.whereis(registry, key);
}

/**
 * Bind every node-first `Process` function to `node`, returning a {@link BoundProcess} whose calls
 * omit the repeated argument (`P.spawn(behavior)`, `P.whereis(name)`, `P.list()`). The `// before`
 * free functions still exist; this is just the ergonomic form for when you work with one node. There
 * is no ambient node to default to — several nodes coexist in one process — so `of` is that choice.
 */
function of(node: NodeHandle): BoundProcess {
  const boundSpawn = ((second: unknown, third?: unknown, fourth?: unknown, fifth?: unknown) =>
    (spawn as (n: NodeHandle, ...rest: unknown[]) => GenServer<unknown> | Pid)(
      node,
      second,
      third,
      fourth,
      fifth,
    )) as BoundProcess['spawn'];
  return {
    spawn: boundSpawn,
    link, // handle-based — no node to bind, so they pass straight through
    exit,
    alive,
    whereis: (name) => whereis(node, name),
    list: () => list(node),
    whereisName: (registry, key) => whereisName(node, registry, key),
    yield: yieldToLoop, // node-independent — passes straight through
  };
}
