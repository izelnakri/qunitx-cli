/**
 * `logger` — Elixir's **`Logger`**: leveled, structured, JSON log output. You could reach for
 * pino/winston, but there's a platform reason to have a thin one HERE: pass it the node's
 * `trace` and every line **auto-carries the ambient distributed-trace id** — so a log written
 * inside a handler is correlated with its cross-node request tree and its `['node','call',…]`
 * telemetry span, with zero app effort. That correlation is the whole point; the logger is a
 * couple dozen lines around it.
 *
 * Structured by construction: each line is a plain object (`{ time, level, msg, …metadata }`),
 * emitted to a `sink` (default: warn/error → `console.error`, else `console.log`, as
 * JSON) only when it meets the level threshold. `child(bindings)` fixes fields for a sub-logger
 * (a request id, a worker name) — pino's child-logger pattern. Universal: no platform imports.
 *
 * ```ts
 * const lines: LogLine[] = [];
 * const log = logger({ sink: (line) => lines.push(line), base: { service: 'api' } });
 * log.info('served', { status: 200 });
 * lines[0].service; // 'api'
 * lines[0].status; // 200
 * lines[0].msg; // 'served'
 * ```
 */

/** Log severity, low to high. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** One structured line: the fixed fields plus whatever metadata (and trace ids) were attached. */
export interface LogLine {
  /** Epoch-ms the line was emitted. */
  time: number;
  /** Its severity. */
  level: LogLevel;
  /** The human message. */
  msg: string;
  /** Metadata, base bindings, and — when a trace is ambient — `traceId`/`span`. */
  [key: string]: unknown;
}

/** A running logger — see {@link logger}. */
export interface Logger {
  /** Log at `debug`. */
  debug(msg: string, meta?: Record<string, unknown>): void;
  /** Log at `info`. */
  info(msg: string, meta?: Record<string, unknown>): void;
  /** Log at `warn`. */
  warn(msg: string, meta?: Record<string, unknown>): void;
  /** Log at `error`. */
  error(msg: string, meta?: Record<string, unknown>): void;
  /** A sub-logger with `bindings` fixed on every line (pino's child pattern). */
  child(bindings: Record<string, unknown>): Logger;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const defaultSink = (line: LogLine): void =>
  (line.level === 'warn' || line.level === 'error' ? console.error : console.log)(
    JSON.stringify(line),
  );

/**
 * Build a {@link Logger}. `level` is the minimum severity emitted (default `info`); `sink`
 * receives each {@link LogLine} (default: JSON to `console`); `base` fixes fields on every line;
 * `trace` is a source of the ambient distributed trace (pass `() => node.trace()`) — when it
 * returns one, `traceId` and `span` are attached automatically.
 *
 * ```ts
 * const lines: LogLine[] = [];
 * const log = logger({
 *   level: 'warn',
 *   sink: (line) => lines.push(line),
 *   trace: () => ({ id: 'req-42', span: 'a1b2' }),
 * });
 * log.info('quiet'); // below threshold — dropped
 * log.error('boom', { code: 500 });
 * lines.length; // 1
 * lines[0].traceId; // 'req-42' — correlated with the request tree
 * lines[0].code; // 500
 * ```
 */
export function logger(
  options: {
    level?: LogLevel;
    sink?: (line: LogLine) => void;
    base?: Record<string, unknown>;
    trace?: () => { id: string; span?: string } | undefined;
  } = {},
): Logger {
  const threshold = RANK[options.level ?? 'info'];
  const sink = options.sink ?? defaultSink;
  const base = options.base ?? {};

  const at = (level: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    if (RANK[level] < threshold) return;
    const trace = options.trace?.();
    sink({
      time: Date.now(),
      level,
      msg,
      ...base,
      ...meta,
      ...(trace ? { traceId: trace.id, span: trace.span } : {}),
    });
  };

  return {
    debug: (msg, meta) => at('debug', msg, meta),
    info: (msg, meta) => at('info', msg, meta),
    warn: (msg, meta) => at('warn', msg, meta),
    error: (msg, meta) => at('error', msg, meta),
    child: (bindings) => logger({ ...options, base: { ...base, ...bindings } }),
  };
}
