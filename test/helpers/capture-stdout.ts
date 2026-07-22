import { format } from 'node:util';

/**
 * Intercepts everything fn() prints — both process.stdout.write and console.log — and returns
 * it as one string. Use this in unit tests to assert on what a function prints without
 * spawning a subprocess.
 *
 * console.log is captured in its own right rather than left to fall through to the patched
 * process.stdout.write. On Node it would fall through; Deno's console does not go via node's
 * stdout shim, so patching the write alone silently misses every console.log — the output
 * escapes to the real terminal and the caller sees an empty string. That failed only on the
 * deno lanes, and only for lib/commands/help.ts, the one captured module that logs rather than
 * writes. Capturing it here rather than delegating also keeps Node from counting it twice.
 *
 * Sync-only, and deliberately so: holding these handles across an await lets node:test's own
 * reporter write into the buffer, and its result lines then vanish from the run summary.
 */
export function captureStdout(fn: () => void): string {
  let captured = '';
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;

  (process.stdout.write as unknown) = (str: string) => {
    captured += str;
    return true;
  };
  console.log = (...args: unknown[]) => {
    captured += `${format(...args)}\n`;
  };
  try {
    fn();
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
  return captured;
}
