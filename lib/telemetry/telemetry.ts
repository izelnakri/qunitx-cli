/**
 * `Telemetry` — Elixir's **`:telemetry`**: the standard instrumentation bus every OTP library
 * emits through, so a system can be measured without each component inventing its own metrics
 * hook. Code `execute`s named events with **measurements** (numbers — a duration, a queue depth)
 * and **metadata** (context — which key, which node); anything that cares `attach`es a handler.
 * Emitter and observer never know about each other, so a Node, a Supervisor, or a room actor can
 * be instrumented and a metrics/tracing sink wired up entirely separately.
 *
 * An event name is a list of segments — Elixir's list of atoms, e.g. `['qunitx', 'node', 'call']`.
 * Handlers attach to an EXACT event; `span` brackets an operation with `…:start` / `…:stop` (or
 * `…:exception`) events carrying a measured `duration`, the shape a tracing backend consumes.
 *
 * ```ts
 * const calls: number[] = [];
 * attach('count-calls', ['app', 'call'], (_event, m) => void calls.push(m.duration));
 * execute(['app', 'call'], { duration: 12 }, { subject: 'ping' });
 * calls; // [12]
 * detach('count-calls');
 * ```
 */

/** An event name — a list of segments (Elixir's list of atoms). */
export type EventName = readonly string[];
/** Numeric samples for an event — a duration, a count, a queue depth. */
export type Measurements = Record<string, number>;
/** Context for an event — which key, which node, which subject. */
export type Metadata = Record<string, unknown>;
/** A handler: invoked with the event, its measurements, metadata, and the config it attached with. */
export type Handler<C = unknown> = (
  event: EventName,
  measurements: Measurements,
  metadata: Metadata,
  config: C,
) => void;

const SEP = '\u001f'; // unit separator — cannot appear in an event segment
const key = (event: EventName): string => event.join(SEP);

interface Attached {
  id: string;
  events: string[]; // serialized event keys this handler is attached to
  handler: Handler<unknown>;
  config: unknown;
}

// Global handler table — :telemetry is process-wide, and so is this. `byId` enforces unique
// handler ids; `byEvent` is the dispatch index execute() walks.
const byId = new Map<string, Attached>();
const byEvent = new Map<string, Set<Attached>>();

/**
 * Attach `handler` to one event under a unique `id` (used to {@link detach}). Throws if the id is
 * already taken — Elixir's `{:error, :already_exists}`. `config` is passed back to the handler on
 * every call (a sink, a label). A handler that throws is auto-detached so a buggy observer can't
 * break the emitter — `:telemetry`'s exact contract.
 *
 * ```ts
 * attach('log-slow', ['db', 'query'], (_e, m, meta) => {
 *   if (m.duration > 100) void meta;
 * });
 * detach('log-slow');
 * ```
 */
export function attach<C = unknown>(
  id: string,
  event: EventName,
  handler: Handler<C>,
  config?: C,
): void {
  attachMany(id, [event], handler, config);
}

/**
 * Attach one `handler` to MANY events under a single `id` — Elixir's `attach_many`. Detaching the
 * id removes it from all of them.
 *
 * ```ts
 * attachMany('trace', [['app', 'call', 'start'], ['app', 'call', 'stop']], () => {});
 * detach('trace');
 * ```
 */
export function attachMany<C = unknown>(
  id: string,
  events: EventName[],
  handler: Handler<C>,
  config?: C,
): void {
  if (byId.has(id)) throw new Error(`telemetry handler ${id} already exists`);
  const record: Attached = {
    id,
    events: events.map(key),
    handler: handler as Handler<unknown>,
    config,
  };
  byId.set(id, record);
  for (const k of record.events) (byEvent.get(k) ?? byEvent.set(k, new Set()).get(k)!).add(record);
}

/**
 * Remove a handler by id, from every event it was attached to. A no-op if the id is unknown.
 *
 * ```ts
 * attach('temp', ['e'], () => {});
 * detach('temp');
 * listHandlers(['e']); // []
 * ```
 */
export function detach(id: string): void {
  const record = byId.get(id);
  if (!record) return;
  byId.delete(id);
  for (const k of record.events) {
    const set = byEvent.get(k);
    if (set) {
      set.delete(record);
      if (set.size === 0) byEvent.delete(k);
    }
  }
}

/**
 * Emit `event` with `measurements` and `metadata` — every attached handler runs synchronously (as
 * in `:telemetry`, so a handler's cost is the emitter's cost; keep them light). A handler that
 * throws is detached and the others still run.
 *
 * ```ts
 * let seen = 0;
 * attach('h', ['app', 'tick'], () => void seen++);
 * execute(['app', 'tick']);
 * seen; // 1
 * detach('h');
 * ```
 */
export function execute(
  event: EventName,
  measurements: Measurements = {},
  metadata: Metadata = {},
): void {
  const set = byEvent.get(key(event));
  if (!set) return;
  for (const record of [...set]) {
    try {
      record.handler(event, measurements, metadata, record.config);
    } catch {
      detach(record.id); // a buggy handler can't be allowed to break the emitter
    }
  }
}

/**
 * Bracket an operation with telemetry — Elixir's `:telemetry.span`. Emits `[...event, 'start']`
 * before running `fn`, then `[...event, 'stop']` with a measured `duration` (ms) on success, or
 * `[...event, 'exception']` on throw (re-raised). `fn` returns the value plus any stop metadata to
 * merge. The duration uses a monotonic clock, so it's immune to wall-clock jumps.
 *
 * ```ts
 * const events: string[] = [];
 * attachMany('span', [['work', 'start'], ['work', 'stop']], (e) => void events.push(e.at(-1)!));
 * const out = await span(['work'], { job: 1 }, async () => ({ result: 6 * 7 }));
 * out; // 42
 * events; // ['start', 'stop']
 * detach('span');
 * ```
 */
export async function span<T>(
  event: EventName,
  startMetadata: Metadata,
  fn: () => { result: T; metadata?: Metadata } | Promise<{ result: T; metadata?: Metadata }>,
): Promise<T> {
  const started = performance.now();
  execute([...event, 'start'], { monotonicTime: started }, startMetadata);
  try {
    const { result, metadata } = await fn();
    execute(
      [...event, 'stop'],
      { duration: performance.now() - started },
      { ...startMetadata, ...metadata },
    );
    return result;
  } catch (error) {
    execute(
      [...event, 'exception'],
      { duration: performance.now() - started },
      { ...startMetadata, kind: 'error', reason: error },
    );
    throw error;
  }
}

/**
 * Handler ids currently attached to `event` (exact match) — Elixir's `list_handlers`.
 *
 * ```ts
 * attach('m', ['metrics', 'flush'], () => {});
 * listHandlers(['metrics', 'flush']); // ['m']
 * detach('m');
 * ```
 */
export function listHandlers(event: EventName): string[] {
  return [...(byEvent.get(key(event)) ?? [])].map((r) => r.id);
}
