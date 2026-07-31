// Elixir's `Process` module, JS-shaped: the process operations that are NOT about an existing
// `self`. `spawn` CREATES a unit (so it can't hang off a self), and the free-function forms
// (`link`/`exit`/`alive`) mirror Elixir's `Process.link(pid)` / `Process.exit(pid, reason)` /
// `Process.alive?(pid)` for callers who hold a handle. Bound-to-self ops live on the handle itself
// (`unit.cast`, `unit.exit`, …) and on the `self` a handler receives — this module is the static side.
import type { Any as AnyFailure } from '../result/failure.ts';
import { genServer, type Behavior, type GenServer, type GenServerOptions } from './gen-server.ts';
import type { NodeHandle } from './node.ts';

// The minimal handle shape the free functions touch — picked so ANY GenServer<S, K> qualifies
// regardless of its state/key types (none of these members mention S or K).
type Unit = Pick<GenServer<unknown, string>, 'link' | 'exit' | 'isAlive'>;

// Monotonic across the process — anonymous names only need to be unique, and the node prefix keeps
// them readable/attributable. Not Math.random/Date.now (a counter is enough and stays deterministic).
let spawnCount = 0;

/**
 * Elixir's `Process` module — the static side of process management, the operations that aren't a
 * method on some existing `self`:
 *
 * - `spawn` CREATES a unit (an anonymous {@link genServer} — no name to invent), returning its handle.
 * - `link` / `exit` / `alive` are the free-function forms of Elixir's `Process.link(pid)` /
 *   `Process.exit(pid, reason)` / `Process.alive?(pid)`, for code that holds a handle.
 * - `whereis` looks a registered name up in the cluster (Elixir's `:global.whereis_name` / Registry).
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
 * Process.exit(counter);
 * node.stop();
 * ```
 */
export const Process = { spawn, link, exit, alive, whereis };

/**
 * Spawn an ANONYMOUS unit on `node` — Elixir's `spawn`: a running process with no name you had to
 * invent. Identical to {@link genServer} but the name is auto-assigned (`<node>:proc:<n>`), so you
 * address it by the returned handle. Pass `{ via }` in `options` if you later want it name-reachable.
 */
function spawn<S, K extends string = string>(
  node: NodeHandle,
  behavior: Behavior<S, K>,
  options?: GenServerOptions,
): GenServer<S, K> {
  spawnCount += 1;
  return genServer(node, `${node.self()}:proc:${spawnCount}`, behavior, options);
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
 * Look a registered name up across the cluster — Elixir's `:global.whereis_name` / a `Registry`
 * lookup: the node that currently hosts `key` in `registry`, or `null` if none. Works for units
 * registered with `{ via: { registry, key } }`.
 */
function whereis(node: NodeHandle, registry: string, key: string): string | null {
  return node.whereis(registry, key);
}
