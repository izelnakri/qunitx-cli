// The telemetry SINK the trace context was always shaped for — a Prometheus-format exporter over the
// node's `:telemetry` events. The core already emits `['node','call','start'|'stop'|'timeout']` (with
// a `duration`) and `['node','handle']`; this subscribes, accumulates counters + a latency histogram,
// and renders the standard exposition text. Universal (telemetry is universal); no Prometheus client
// dependency — hand `.prometheus()` to any HTTP `/metrics` route. Detach with `.stop()`.
import { attachMany, detach } from '../telemetry/telemetry.ts';

/** Prometheus histogram buckets for call latency (ms), ascending. `+Inf` is implicit (the total). */
const BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000] as const;

/** A point-in-time read of the collected metrics — the structured form behind {@link Metrics.prometheus}. */
export interface MetricsSnapshot {
  /** Calls initiated from this process (`['node','call','start']`). */
  callsStarted: number;
  /** Calls that got a reply (`['node','call','stop']`), success or declared failure. */
  callsCompleted: number;
  /** Of the completed, how many replied with a declared failure. */
  callErrors: number;
  /** Calls that hit their deadline (`['node','call','timeout']`). */
  callTimeouts: number;
  /** Inbound messages dispatched to a handler (`['node','handle']`). */
  handled: number;
  /** Call-latency histogram (ms): total count, summed duration, and cumulative bucket counts. */
  duration: { count: number; sumMs: number; buckets: Record<string, number> };
}

/** A running metrics collector — {@link collectMetrics} returns one. Read it, render it, then `stop()`. */
export interface Metrics {
  /** The current counters + histogram as data. */
  snapshot(): MetricsSnapshot;
  /** The Prometheus text-exposition form — serve at `/metrics`. */
  prometheus(): string;
  /** Detach from telemetry (idempotent). */
  stop(): void;
}

/**
 * Start collecting node metrics from the global telemetry stream. Because telemetry is process-wide,
 * one collector observes every node in the process. Serve `.prometheus()` from an HTTP route, or read
 * `.snapshot()` in tests/dashboards.
 *
 * ```ts
 * import { execute } from '../telemetry/telemetry.ts';
 *
 * const m = collectMetrics();
 * execute(['node', 'call', 'start'], {}, { subject: 'ping' });
 * execute(['node', 'call', 'stop'], { duration: 3 }, { subject: 'ping', error: false });
 * m.snapshot().callsCompleted; // 1
 * m.prometheus().includes('node_calls_total 1'); // true
 * m.stop();
 * ```
 */
export function collectMetrics(options: { prefix?: string } = {}): Metrics {
  const prefix = options.prefix ?? 'node';
  const snap: MetricsSnapshot = {
    callsStarted: 0,
    callsCompleted: 0,
    callErrors: 0,
    callTimeouts: 0,
    handled: 0,
    duration: { count: 0, sumMs: 0, buckets: Object.fromEntries(BUCKETS_MS.map((b) => [b, 0])) },
  };
  const observe = (ms: number): void => {
    snap.duration.count += 1;
    snap.duration.sumMs += ms;
    for (const bucket of BUCKETS_MS) if (ms <= bucket) snap.duration.buckets[bucket] += 1;
  };

  const id = `metrics-${crypto.randomUUID().slice(0, 8)}`;
  attachMany(
    id,
    [
      ['node', 'call', 'start'],
      ['node', 'call', 'stop'],
      ['node', 'call', 'timeout'],
      ['node', 'handle'],
    ],
    (event, measurements, metadata) => {
      const name = event.join('.');
      if (name === 'node.call.start') snap.callsStarted += 1;
      else if (name === 'node.call.stop') {
        snap.callsCompleted += 1;
        if (metadata.error === true) snap.callErrors += 1;
        observe(measurements.duration ?? 0);
      } else if (name === 'node.call.timeout') {
        snap.callTimeouts += 1;
        observe(measurements.duration ?? 0);
      } else if (name === 'node.handle') snap.handled += 1;
    },
  );

  return {
    snapshot: () => ({
      ...snap,
      duration: { ...snap.duration, buckets: { ...snap.duration.buckets } },
    }),
    prometheus() {
      const lines: string[] = [];
      const counter = (metric: string, help: string, value: number): void => {
        lines.push(`# HELP ${prefix}_${metric} ${help}`, `# TYPE ${prefix}_${metric} counter`);
        lines.push(`${prefix}_${metric} ${value}`);
      };
      counter('calls_total', 'Calls initiated from this process.', snap.callsStarted);
      counter('call_completed_total', 'Calls that received a reply.', snap.callsCompleted);
      counter('call_errors_total', 'Completed calls that returned a failure.', snap.callErrors);
      counter('call_timeouts_total', 'Calls that hit their deadline.', snap.callTimeouts);
      counter('handled_total', 'Inbound messages dispatched to a handler.', snap.handled);
      lines.push(
        `# HELP ${prefix}_call_duration_ms Call round-trip latency in milliseconds.`,
        `# TYPE ${prefix}_call_duration_ms histogram`,
      );
      for (const bucket of BUCKETS_MS)
        lines.push(
          `${prefix}_call_duration_ms_bucket{le="${bucket}"} ${snap.duration.buckets[bucket]}`,
        );
      lines.push(`${prefix}_call_duration_ms_bucket{le="+Inf"} ${snap.duration.count}`);
      lines.push(`${prefix}_call_duration_ms_sum ${snap.duration.sumMs}`);
      lines.push(`${prefix}_call_duration_ms_count ${snap.duration.count}`);
      return lines.join('\n') + '\n';
    },
    stop: () => detach(id),
  };
}
