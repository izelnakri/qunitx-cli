// The cooperative scheduler — the runtime's answer to BEAM's preemptive fairness, adapted to a
// single-threaded event loop. BEAM preempts every process after ~2000 reductions so no process
// starves the others; JS cannot preempt running code, but it CAN yield the event loop at chosen
// points. The mailbox pump (see gen-server.ts) spends a "reduction" per message and, when its slice
// is exhausted, awaits one of the yields here — handing the loop back so timers, I/O callbacks, and
// every OTHER actor's pump get a turn before it resumes. That is the whole cooperative-fairness
// story: not a guarantee against hostile `while(true){}`, but fairness for every workload that ever
// awaits. Standalone and dependency-free on purpose — other projects can lift this file wholesale.

/**
 * Scheduling priority — BEAM's process priority levels, minus `max` (which BEAM reserves for the
 * kernel). A `high` actor's pump resumes before a `normal` one, which resumes before a `low` one,
 * whenever they yield in the same tick — so a flood of background work can't delay a latency-
 * sensitive actor.
 */
export type Priority = 'high' | 'normal' | 'low';

const RANK: Record<Priority, number> = { high: 2, normal: 1, low: 0 };

/**
 * The higher of two priorities (`high` > `normal` > `low`) — used to elevate a unit's pump to the
 * priority of the message it is draining.
 *
 * ```ts
 * higher('low', 'high'); // 'high'
 * higher('normal', 'low'); // 'normal'
 * ```
 */
export const higher = (a: Priority, b: Priority): Priority => (RANK[a] >= RANK[b] ? a : b);

// The universal macrotask primitive: run `cb` on the next event-loop turn (NOT a microtask). This is
// the crux — an `await`ed synchronous value only yields a MICROtask, and the microtask queue drains
// to exhaustion before the loop processes timers/I-O. A macrotask hop is what actually hands the loop
// back. `setImmediate` on Node/Deno; a `MessageChannel` message elsewhere (both are macrotasks); a
// `setTimeout(0)` last resort (clamped to ~4ms, but always present).
const nextMacrotask: (cb: () => void) => void =
  typeof setImmediate === 'function'
    ? (cb) => void setImmediate(cb)
    : typeof MessageChannel === 'function'
      ? (() => {
          const { port1, port2 } = new MessageChannel();
          const pending: Array<() => void> = [];
          port1.onmessage = () => pending.shift()?.();
          return (cb: () => void) => {
            pending.push(cb);
            port2.postMessage(0);
          };
        })()
      : (cb) => void setTimeout(cb, 0);

/**
 * Yield the event loop for exactly one macrotask, then resume. The primitive a long-running handler
 * reaches for (exposed as `Process.yield`) and the plain, priority-free yield the pump uses when no
 * priority ordering is needed. Microtasks queued before the call drain first — that is the point.
 *
 * ```ts
 * const order: string[] = [];
 * queueMicrotask(() => order.push('micro'));
 * await yieldToLoop();
 * order.push('after-yield');
 * order[0]; // 'micro' — the microtask drained before the macrotask resumed
 * ```
 */
export const yieldToLoop = (): Promise<void> => new Promise((resolve) => nextMacrotask(resolve));

// Parked resumers, bucketed by priority. Everything that yields within one tick releases together on
// the next macrotask, HIGH first — so higher-priority pumps get the CPU back before lower ones. This
// orders RESUMPTION only; it never serializes execution (each actor keeps its own independent async
// body), so one actor awaiting slow I/O can't stall another — the event loop already handles that.
const parked: Record<Priority, Array<() => void>> = { high: [], normal: [], low: [] };
let flushScheduled = false;

/**
 * Yield the loop, resuming in priority order relative to everything else that yielded this tick. A
 * `high` caller's promise settles before a `normal` one's, before a `low` one's — the cross-actor
 * fairness knob. Like {@link yieldToLoop} it costs exactly one macrotask; it only reorders who
 * wakes first within that macrotask.
 *
 * ```ts
 * const order: string[] = [];
 * const lo = yieldWith('low').then(() => order.push('low'));
 * const hi = yieldWith('high').then(() => order.push('high'));
 * await Promise.all([lo, hi]);
 * order.join(','); // 'high,low' — high-priority resumes first within the shared tick
 * ```
 */
export const yieldWith = (priority: Priority = 'normal'): Promise<void> =>
  new Promise((resolve) => {
    parked[priority].push(resolve);
    if (flushScheduled) return;
    flushScheduled = true;
    nextMacrotask(() => {
      flushScheduled = false;
      const batch = [...parked.high, ...parked.normal, ...parked.low];
      parked.high = [];
      parked.normal = [];
      parked.low = [];
      for (const resume of batch) resume(); // HIGH→NORMAL→LOW: higher priority wakes first
    });
  });
