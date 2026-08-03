/**
 * Where a run's text goes.
 *
 * Every reporter and every `#` diagnostic writes through the run's {@link Output} rather than
 * touching `process.stdout` directly, which is what makes "run these tests and don't print
 * anything" expressible at all — and what lets a caller point the built-in TAP reporter at a
 * file, a socket, or a string buffer without the run knowing the difference.
 *
 * Two methods rather than one Writable, because the only two things the run does are "say
 * something" and "say something that also belongs on stderr". A `Writable` would additionally
 * drag in backpressure, encodings and a close lifecycle that no caller here has to think about.
 *
 * ```ts
 * const lines: string[] = [];
 * const output: Output = { write: (text) => void lines.push(text), error: () => {} };
 * output.write('ok 1 Math | adds\n');
 * lines; // ['ok 1 Math | adds\n']
 * ```
 */
export interface Output {
  /** Writes to the primary stream — the TAP/spec/dot document itself. */
  write(text: string): void;
  /** Writes to the error stream. Diagnostics that must survive a swallowed stdout go here too. */
  error(text: string): void;
}

/**
 * The CLI's output: the real process streams.
 *
 * ```ts
 * import { processOutput } from './output.ts';
 *
 * // Defined, not invoked: writes to the host process's stdout.
 * function announce() {
 *   processOutput.write('TAP version 13\n');
 * }
 * ```
 */
export const processOutput: Output = {
  write: (text) => void process.stdout.write(text),
  error: (text) => void process.stderr.write(text),
};

/**
 * An output that discards everything. The JS API's default, so a programmatic run is silent
 * unless the caller asks for a reporter and somewhere to put it.
 *
 * ```ts
 * import { silentOutput } from './output.ts';
 *
 * silentOutput.write('nothing happens'); // undefined — and nothing is printed
 * ```
 */
export const silentOutput: Output = { write: () => {}, error: () => {} };

/**
 * Adapts anything with a `write(string)` method — a `node:fs` write stream, a socket, an
 * `http.ServerResponse` — into an {@link Output}. `stderr` defaults to `stdout`, so passing one
 * stream collects the whole run into it.
 *
 * ```ts
 * import { streamOutput } from './output.ts';
 *
 * const chunks: string[] = [];
 * const output = streamOutput({ write: (text: string) => void chunks.push(text) });
 * output.error('# warning\n');
 * chunks; // ['# warning\n'] — with no stderr given, both channels land in the one stream
 * ```
 */
export function streamOutput(
  stdout: { write(text: string): unknown },
  stderr: { write(text: string): unknown } = stdout,
): Output {
  return {
    write: (text) => void stdout.write(text),
    error: (text) => void stderr.write(text),
  };
}
