/**
 * `Supervisor` — OTP's supervision shape for in-process JS: children are long-running
 * functions given an `AbortSignal`; when one settles unexpectedly the supervisor restarts it
 * according to its `restart` policy and the supervisor's `strategy`, within a restart
 * intensity budget. When the budget is exceeded the supervisor gives up LOUDLY: `done`
 * rejects with a declared `Failure('SupervisorShutdown')`.
 *
 * What this is: restart policies, strategies, and intensity accounting — the decision logic
 * of OTP supervision, usable in any JS runtime (browser included). What this is NOT: process
 * isolation. A JS child that never yields the event loop cannot be preempted, and a child
 * that leaks memory leaks in the shared heap. True isolation needs Workers/processes — the
 * `Node` module's territory, one layer up.
 *
 * ```ts
 * const events: string[] = [];
 * const sup = start([
 *   { id: 'greeter', restart: 'transient', start: () => void events.push('hello') },
 * ]);
 * await sup.stop(); // transient child exited NORMALLY: no restart, clean stop
 * events; // ['hello']
 * ```
 */
import {
  Failure,
  from as classifyThrown,
  observed,
  type Any as AnyFailure,
} from '../result/failure.ts';
import { Task } from '../task/task.ts';

/**
 * One supervised child. `start` is invoked per (re)start with a fresh `AbortSignal`; the
 * child "exits" when its returned promise settles, and the signal fires when the supervisor
 * stops it (stop/strategy) — cooperative shutdown, like every signal in this system.
 *
 * ```ts
 * const spec: ChildSpec = {
 *   id: 'poller',
 *   restart: 'permanent',
 *   start: (signal) => new Promise<void>((done) => signal.addEventListener('abort', () => done())),
 * };
 * spec.id; // 'poller'
 * ```
 */
export interface ChildSpec {
  /** Unique name within this supervisor — the key restarts and strategies group by. */
  id: string;
  /** The child body. Settling = exiting: resolve is a normal exit, reject is a crash. */
  start: (signal: AbortSignal) => unknown | PromiseLike<unknown>;
  /**
   * OTP's three policies: `permanent` restarts on ANY exit, `transient` only on a crash,
   * `temporary` never (default: `permanent`, like OTP).
   */
  restart?: 'permanent' | 'transient' | 'temporary';
}

/**
 * Supervisor options — OTP's `strategy` and restart intensity, camelCased.
 *
 * ```ts
 * const options: Options = { strategy: 'oneForOne', maxRestarts: 3, maxSeconds: 5 };
 * options.strategy; // 'oneForOne'
 * ```
 */
export interface Options {
  /** `oneForOne` restarts the exited child; `oneForAll` restarts every child; `restForOne` the exited child and all started after it. */
  strategy?: 'oneForOne' | 'oneForAll' | 'restForOne';
  /** Give up after more than `maxRestarts` restarts within `maxSeconds` (OTP defaults: 3 in 5). */
  maxRestarts?: number;
  /** The window, in seconds, that `maxRestarts` is counted over. */
  maxSeconds?: number;
}

/**
 * The running supervisor: inspect children, stop cleanly, or await `done` — which settles
 * only when supervision ENDS (resolves on `stop()`, rejects with the declared
 * `Failure('SupervisorShutdown')` when the restart budget is exhausted).
 *
 * ```ts
 * const sup = start([{ id: 'a', restart: 'temporary', start: () => 'done' }]);
 * sup.count(); // 1
 * await sup.stop();
 * ```
 */
export interface SupervisorHandle {
  /** Child ids in start order. */
  children(): string[];
  /** How many children are currently running. */
  count(): number;
  /** Aborts children in REVERSE start order, awaits their exits, resolves `done`. */
  stop(): Promise<void>;
  /** Settles when supervision ends — the crash-boundary hook for the whole tree. */
  done: Task<void, AnyFailure>;
}

type Running = {
  spec: Required<ChildSpec>;
  controller: AbortController;
  exited: Promise<void>;
};

/**
 * Starts supervising `children` in order — Elixir's `Supervisor.start_link/2`, minus the
 * process (the handle is the "pid"). Child crashes are DECLARED failures from the
 * supervisor's point of view: each one is classified, reported to the observation seam, and
 * answered with a restart — until the intensity budget says the tree is beyond restarting.
 *
 * ```ts
 * let attempts = 0;
 * const sup = start(
 *   [{ id: 'flaky', restart: 'transient', start: () => { if (++attempts < 3) throw new Error('crash'); } }],
 *   { maxRestarts: 5, maxSeconds: 5 },
 * );
 * await new Promise((r) => setTimeout(r, 50)); // two crashes, two restarts, then a normal exit
 * attempts; // 3
 * await sup.stop();
 * ```
 */
export function start(children: ChildSpec[], options: Options = {}): SupervisorHandle {
  const { strategy = 'oneForOne', maxRestarts = 3, maxSeconds = 5 } = options;
  const order = children.map((spec): Required<ChildSpec> => ({ restart: 'permanent', ...spec }));
  const running = new Map<string, Running>();
  const restarts: number[] = []; // timestamps of recent restarts — the intensity window
  let ended = false;
  let endSupervision!: (outcome?: AnyFailure) => void;
  const done = new Task<void, AnyFailure>(
    () =>
      new Promise<void>((resolve, reject) => {
        endSupervision = (outcome) => (outcome ? reject(outcome) : resolve());
      }),
  ).perform();

  const spawn = (spec: Required<ChildSpec>): void => {
    const controller = new AbortController();
    const entry: Running = { spec, controller, exited: Promise.resolve() };
    entry.exited = Promise.resolve()
      .then(() => spec.start(controller.signal))
      .then(
        () => onExit(entry, null),
        (crash: unknown) => onExit(entry, classifyThrown(crash)),
      );
    running.set(spec.id, entry);
  };

  const onExit = async (entry: Running, crash: AnyFailure | null): Promise<void> => {
    // Stale exits (an aborted cohort peer, a replaced child) were removed from the map
    // BEFORE their abort fired, so map identity is the entire staleness test.
    if (ended || running.get(entry.spec.id) !== entry) return;
    // This incarnation is over whatever happens next — and it must leave the map NOW, or a
    // shutdown triggered further down would await the very exit being handled (deadlock).
    running.delete(entry.spec.id);
    if (crash) observed(crash); // the supervisor HANDLES this failure: report, then act
    const policy = entry.spec.restart;
    const wantsRestart = policy === 'permanent' || (policy === 'transient' && crash !== null);
    if (!wantsRestart) return;

    const now = Date.now();
    restarts.push(now);
    while (restarts.length > 0 && restarts[0] < now - maxSeconds * 1000) restarts.shift();
    if (restarts.length > maxRestarts) {
      await shutdown(
        new Failure(
          'SupervisorShutdown',
          `restart intensity exceeded: ${restarts.length} restarts in ${maxSeconds}s`,
          { id: entry.spec.id },
          crash ? { cause: crash } : {},
        ),
      );
      return;
    }

    // Which children the strategy takes down with the exited one, in start order.
    const index = order.findIndex((spec) => spec.id === entry.spec.id);
    const cohort =
      strategy === 'oneForOne'
        ? [order[index]]
        : strategy === 'restForOne'
          ? order.slice(index)
          : order;
    const respawn = new Set([entry.spec.id]);
    for (const spec of [...cohort].reverse()) {
      const peer = running.get(spec.id);
      if (peer && peer !== entry) {
        respawn.add(spec.id);
        running.delete(spec.id); // stale BEFORE the abort, so its exit cannot re-enter here
        peer.controller.abort();
        await peer.exited;
      }
    }
    for (const spec of cohort) if (respawn.has(spec.id)) spawn(spec);
  };

  const shutdown = async (outcome?: AnyFailure): Promise<void> => {
    if (ended) return;
    ended = true;
    for (const spec of [...order].reverse()) {
      const peer = running.get(spec.id);
      if (peer) {
        peer.controller.abort();
        await peer.exited.catch(() => undefined);
        running.delete(spec.id);
      }
    }
    endSupervision(outcome);
  };

  for (const spec of order) spawn(spec);

  return {
    children: () => order.filter((spec) => running.has(spec.id)).map((spec) => spec.id),
    count: () => running.size,
    stop: () => shutdown(),
    done,
  };
}

/**
 * The handle of a {@link dynamic} supervisor — OTP's `DynamicSupervisor`. Children are added
 * and removed at RUNTIME (`startChild`/`terminateChild`), unlike {@link start}'s fixed list.
 *
 * ```ts
 * const sup = dynamic();
 * const id = sup.startChild({ id: 'job-1', restart: 'temporary', start: () => 'done' });
 * sup.count(); // 1
 * await sup.stop();
 * ```
 */
export interface DynamicSupervisorHandle {
  /** Starts and supervises a child NOW — Elixir's `start_child/2`. Returns its id. */
  startChild(spec: ChildSpec): string;
  /** Aborts and removes one child — Elixir's `terminate_child/2`. */
  terminateChild(id: string): Promise<void>;
  /** Running child ids. */
  children(): string[];
  /** How many children are currently running. */
  count(): number;
  /** Aborts every child (reverse start order) and ends supervision. */
  stop(): Promise<void>;
  /** Settles when supervision ends — resolves on `stop()`, rejects `SupervisorShutdown` on intensity. */
  done: Task<void, AnyFailure>;
}

/**
 * A dynamic supervisor — OTP's `DynamicSupervisor`: no static child list, children come and go
 * at runtime, always `one_for_one` (a child's crash never touches its siblings — the whole
 * point of dynamic supervision). The restart intensity budget is shared across all children;
 * exceeding it ends the tree loudly, exactly like {@link start}.
 *
 * The canonical use is one supervised process per live thing — a session, a job, a chat room
 * (see examples/realtime-chat) — usually paired with a registry so callers can find the child
 * for a key.
 *
 * ```ts
 * let ran = 0;
 * const sup = dynamic();
 * sup.startChild({
 *   id: 'w',
 *   restart: 'permanent',
 *   // exits once (permanent restarts it), then parks on the abort signal
 *   start: (signal) =>
 *     ++ran === 1 ? undefined : new Promise<void>((r) => signal.addEventListener('abort', () => r())),
 * });
 * await new Promise((r) => setTimeout(r, 30));
 * ran; // 2 — restarted once, then held
 * await sup.stop();
 * ```
 */
export function dynamic(
  options: { maxRestarts?: number; maxSeconds?: number } = {},
): DynamicSupervisorHandle {
  const { maxRestarts = 3, maxSeconds = 5 } = options;
  const running = new Map<string, Running>();
  const insertion = new Set<string>(); // start order (Set = ordered + O(1) removal)
  const restarts: number[] = [];
  let ended = false;
  let endSupervision!: (outcome?: AnyFailure) => void;
  const done = new Task<void, AnyFailure>(
    () =>
      new Promise<void>((resolve, reject) => {
        endSupervision = (outcome) => (outcome ? reject(outcome) : resolve());
      }),
  ).perform();

  const spawn = (spec: Required<ChildSpec>): void => {
    const controller = new AbortController();
    const entry: Running = { spec, controller, exited: Promise.resolve() };
    entry.exited = Promise.resolve()
      .then(() => spec.start(controller.signal))
      .then(
        () => onExit(entry, null),
        (crash: unknown) => onExit(entry, classifyThrown(crash)),
      );
    running.set(spec.id, entry);
  };

  const onExit = async (entry: Running, crash: AnyFailure | null): Promise<void> => {
    if (ended || running.get(entry.spec.id) !== entry) return; // stale
    running.delete(entry.spec.id);
    if (crash) observed(crash);
    const policy = entry.spec.restart;
    const wantsRestart = policy === 'permanent' || (policy === 'transient' && crash !== null);
    if (!wantsRestart) {
      insertion.delete(entry.spec.id); // O(1) — was indexOf+splice (O(n) → O(n^2) churn)
      return;
    }
    const now = Date.now();
    restarts.push(now);
    while (restarts.length > 0 && restarts[0] < now - maxSeconds * 1000) restarts.shift();
    if (restarts.length > maxRestarts) {
      await shutdown(
        new Failure(
          'SupervisorShutdown',
          `restart intensity exceeded: ${restarts.length} restarts in ${maxSeconds}s`,
          { id: entry.spec.id },
          crash ? { cause: crash } : {},
        ),
      );
      return;
    }
    spawn(entry.spec); // one_for_one: only this child comes back
  };

  const shutdown = async (outcome?: AnyFailure): Promise<void> => {
    if (ended) return;
    ended = true;
    for (const id of [...insertion].reverse()) {
      const peer = running.get(id);
      if (peer) {
        peer.controller.abort();
        await peer.exited.catch(() => undefined);
        running.delete(id);
      }
    }
    insertion.clear();
    endSupervision(outcome);
  };

  return {
    startChild(spec) {
      if (ended) throw new Failure('SupervisorShutdown', 'supervisor has ended', { id: spec.id });
      const full: Required<ChildSpec> = { restart: 'permanent', ...spec };
      insertion.add(full.id);
      spawn(full);
      return full.id;
    },
    async terminateChild(id) {
      const peer = running.get(id);
      if (!peer) return;
      peer.controller.abort();
      await peer.exited.catch(() => undefined);
      running.delete(id);
      insertion.delete(id); // O(1)
    },
    children: () => [...insertion].filter((id) => running.has(id)),
    count: () => running.size,
    stop: () => shutdown(),
    done,
  };
}
