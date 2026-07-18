import type { EventEmitter } from 'node:events';

/**
 * Wraps an `EventEmitter`'s subscription methods so each returns the API object rather than the
 * emitter, keeping `handle.on(...).on(...)` chainable. Callers cast the result to their own
 * typed surface (`RunHandle`, `WatchSession`), which is where the event-to-listener mapping is
 * actually enforced — the emitter underneath is untyped.
 */
export function chainableEmitter(emitter: EventEmitter): {
  on: (event: string, listener: (...args: never[]) => void) => unknown;
  once: (event: string, listener: (...args: never[]) => void) => unknown;
  off: (event: string, listener: (...args: never[]) => void) => unknown;
} {
  const subscribe = (method: 'on' | 'once' | 'off') =>
    function chainable(this: unknown, event: string, listener: (...args: never[]) => void) {
      emitter[method](event, listener as (...args: unknown[]) => void);
      return this;
    };

  return { on: subscribe('on'), once: subscribe('once'), off: subscribe('off') };
}
