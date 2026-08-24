import process from 'node:process';

/** The signals a supervisor stops a CLI with, and the number each conventionally exits as. */
const SIGNALS: Record<string, number> = { SIGTERM: 15, SIGINT: 2, SIGHUP: 1 };

/**
 * Turns a termination signal into an ordinary exit, so `process.on('exit')` handlers still run.
 *
 * Node's DEFAULT handling of these signals terminates the process without running exit listeners.
 * That is the whole problem: playwright kills the browser it launched from a synchronous
 * `process.on('exit')` handler, and the pre-launched Chrome is reaped from another. Killed by a
 * signal with no listener, neither fires, and the browser outlives the run.
 *
 * On CI that compounds. A supervisor kills a slow run, its browser survives, the leftover browsers
 * compete for the machine, the next run is slower, and more get killed — which is what a
 * Firefox-on-Windows lane looked like when every test took four times its usual duration and the
 * ones that fell off the end reported `page.goto: Timeout 60000ms exceeded`.
 *
 * Exiting rather than cleaning up is deliberate, and is why playwright's own `handleSIGTERM` stays
 * off: its handler starts an ASYNC graceful close that can hang, and a process being told to stop
 * has no time to spend. `process.exit` runs the synchronous handlers and goes.
 *
 * Windows gets nothing from this and cannot: `child.kill()` there is `TerminateProcess`, which no
 * handler in this process can intercept. Whoever does the killing has to take the tree down — see
 * the test runner's own `spawnCapture`.
 *
 * ```ts
 * import { exitOnSignal } from './exit-on-signal.ts';
 *
 * const exits: number[] = [];
 * const signals = new Map<string, () => void>();
 * exitOnSignal({
 *   once: (signal, handler) => void signals.set(signal, handler),
 *   exit: (code) => void exits.push(code),
 * });
 * signals.get('SIGTERM')!();
 * exits; // [143] — 128 + 15, the conventional code for a SIGTERM death
 * ```
 */
export function exitOnSignal({
  once = (signal: string, handler: () => void) => void process.once(signal, handler),
  exit = (code: number) => process.exit(code),
}: {
  once?: (signal: string, handler: () => void) => void;
  exit?: (code: number) => void;
} = {}): void {
  for (const [signal, number] of Object.entries(SIGNALS)) {
    once(signal, () => exit(128 + number));
  }
}
