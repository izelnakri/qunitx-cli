/**
 * Where a run's text goes: `console`, made injectable.
 *
 * Every reporter line, every `#` diagnostic and the TAP document itself go through the run's
 * {@link Console} instead of touching `process.stdout`. That is what makes "run these tests and
 * print nothing" expressible, and what lets a caller point the built-in reporters at a buffer.
 *
 * The same two channels the global has, and no more: severity lives on `Notice.level`, set by
 * `Reporter.info`/`warning`/`error`. A `Writable` would drag in backpressure, encodings and a
 * close lifecycle that nothing here has to think about.
 *
 * This module imports nothing, on purpose. `lib/tap`, `lib/setup`, `lib/commands/daemon` and
 * `lib/api` all need it, and `lib/reporters` already imports `lib/tap` — so a leaf is the only
 * home that neither inverts a layer nor closes a cycle.
 *
 * ```ts
 * import { streamConsole } from './console.ts';
 *
 * const lines: string[] = [];
 * streamConsole({ write: (text: string) => void lines.push(text) }).log('ok 1 Math | adds\n');
 * lines; // ['ok 1 Math | adds\n']
 * ```
 */
export interface Console {
  /** Writes to the primary stream — the TAP/spec/dot document itself. */
  log(text: string): void;
  /** Writes to the error stream. Diagnostics that must survive a swallowed stdout go here too. */
  error(text: string): void;
}

/**
 * Adapts anything with a `write(string)` — a `node:fs` stream, a socket, an array-backed fake —
 * into a {@link Console}. `stderr` defaults to `stdout`, so one stream collects the whole run.
 *
 * ```ts
 * import { streamConsole } from './console.ts';
 *
 * const chunks: string[] = [];
 * streamConsole({ write: (text: string) => void chunks.push(text) }).error('# warning\n');
 * chunks; // ['# warning\n'] — with no stderr given, both channels land in the one stream
 * ```
 */
export function streamConsole(
  stdout: { write(text: string): unknown },
  stderr: { write(text: string): unknown } = stdout,
): Console {
  return {
    log: (text) => void stdout.write(text),
    error: (text) => void stderr.write(text),
  };
}

/**
 * The CLI's: the real process streams. `.write` is looked up per call, so the daemon's stdout
 * interception still reaches it.
 *
 * ```ts
 * import { processConsole } from './console.ts';
 *
 * // Defined, not invoked: writes to the host process's stdout.
 * function announce() {
 *   processConsole.log('TAP version 13\n');
 * }
 * ```
 */
export const processConsole: Console = streamConsole(process.stdout, process.stderr);

/**
 * Discards everything. The JS API's default, so a programmatic run prints nothing unless it was
 * asked to.
 *
 * ```ts
 * import { silentConsole } from './console.ts';
 *
 * silentConsole.log('nothing happens'); // undefined — and nothing is printed
 * ```
 */
export const silentConsole: Console = { log: () => {}, error: () => {} };
