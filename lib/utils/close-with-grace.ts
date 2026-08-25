/**
 * Default grace period for the cleanup race — generous enough for a healthy shutdown of
 * Playwright + HTTP server + Chrome pre-launch, well under the 60 s outer kill the test
 * runner imposes, and tuned around Firefox + Windows where `browser.close()` is known to
 * deadlock for the full 60 s.
 *
 * ```ts
 * CLEANUP_GRACE_MS; // 10_000 — the default `graceMs` of closeWithGrace()
 * ```
 */
export const CLEANUP_GRACE_MS = 10_000;

/**
 * Awaits every cleanup promise in `closes`, but never longer than `graceMs`. Resolves
 * whichever happens first: every close settles (`Promise.allSettled` absorbs rejections
 * so a single failing close cannot wedge the others), or the grace timer fires. Pending
 * closes keep running in the background after a timeout — the caller is expected to
 * `process.exit()` shortly after, which terminates them anyway.
 *
 * On timeout, writes one line to stderr so the user sees that shutdown was cut short.
 * This is an exceptional condition — not verbose output — so it fires regardless of
 * `--debug`: every user who hits the deadlock deserves to know browser/server cleanup
 * may have left orphans. Goes to stderr so it never lands in the TAP stream.
 *
 * `null` / `undefined` entries are accepted as-is so optional-chained closes such as
 * `connections.server?.close()` flow in without per-call filtering. Keyed rather than positional
 * so the timeout can name what it gave up on.
 *
 * Resolves with what it abandoned: the names, and `settled` — a promise for the moment those
 * finally finish. Giving up on a close is not the same as being done with it, and a caller that
 * outlives this one (a watch session restarting) has to be able to come back for it. Without
 * that, an abandoned browser close holds its transport open for the life of the process, and
 * nothing ever looks at it again.
 *
 * ```ts
 * const browserClose = Promise.resolve();
 * const serverClose: Promise<void> | undefined = undefined; // e.g. connections.server?.close()
 *
 * (await closeWithGrace({ browser: browserClose, server: serverClose })).names; // [] — all settled
 * (await closeWithGrace({ wedged: Promise.reject(new Error('x')) }, 50)).names; // [] — a rejection settles
 * ```
 */
export function closeWithGrace(
  closes: Readonly<Record<string, Promise<unknown> | null | undefined>>,
  graceMs: number = CLEANUP_GRACE_MS,
): Promise<Abandoned> {
  const entries = Object.entries(closes);
  const pending = new Set(entries.filter(([, close]) => close).map(([name]) => name));
  const all = Promise.allSettled(
    entries.map(([name, close]) =>
      Promise.resolve(close).finally(() => {
        pending.delete(name);
      }),
    ),
  );

  return new Promise<Abandoned>((resolve) => {
    const timer = setTimeout(() => {
      const names = [...pending];
      // NAMING what did not settle, because "cleanup timed out" is a symptom and the handle still
      // held is the bug. This line is the only evidence a CI runner leaves behind, and one that
      // says which close hung turns a week of guessing into a stack trace.
      process.stderr.write(
        `# qunitx: cleanup timed out after ${graceMs} ms — still pending: ${names.join(', ')} — exiting anyway\n`,
      );
      // `all` is handed back rather than dropped: these closes are still running, and whoever
      // outlives this call may need to wait for them before claiming everything is released.
      resolve({ names, settled: all.then(() => {}) });
    }, graceMs);

    all.then(() => {
      clearTimeout(timer);
      resolve(NOTHING_ABANDONED);
    });
  });
}

/** What {@link closeWithGrace} gave up on, and a promise for those closes finally finishing. */
export interface Abandoned {
  /** The keys still pending when the grace expired. Empty when everything settled in time. */
  names: string[];
  /** Settles when the abandoned closes do. Already settled when nothing was abandoned. */
  settled: Promise<void>;
}

const NOTHING_ABANDONED: Abandoned = { names: [], settled: Promise.resolve() };

/**
 * Closes, and does not come back while anything it started is still running.
 *
 * {@link closeWithGrace} is for a caller that is about to exit: it bounds the wait and walks away,
 * because the process is going to take the leftovers with it. A LIBRARY has no such luxury. When
 * `run()` or `close()` returns, the caller is entitled to end — and a browser close still in flight
 * holds its transport and its process handle, so the caller ends up hanging on a session it was
 * told it had finished with.
 *
 * So this gives what it abandoned a second chance to finish before answering. Two bounded waits
 * rather than one unbounded one: a close that is merely SLOW — which on a loaded Windows runner is
 * most of them — lands in the second, and a genuinely deadlocked one still cannot wedge the caller
 * forever. What is still pending after that is returned rather than swallowed, because at that
 * point nothing else is going to release it and the caller deserves to know.
 *
 * ```ts
 * import { closeCompletely } from './close-with-grace.ts';
 *
 * await closeCompletely({ server: Promise.resolve() }); // [] — nothing was left running
 * await closeCompletely({ wedged: new Promise(() => {}) }, 10); // ['wedged'] — and it says so
 * ```
 */
export async function closeCompletely(
  closes: Readonly<Record<string, Promise<unknown> | null | undefined>>,
  graceMs: number = CLEANUP_GRACE_MS,
): Promise<string[]> {
  const abandoned = await closeWithGrace(closes, graceMs);
  if (!abandoned.names.length) return [];

  // Keyed by what was actually left, so a second timeout names the same closes as the first.
  const second = await closeWithGrace({ [abandoned.names.join(', ')]: abandoned.settled }, graceMs);

  return second.names.length ? abandoned.names : [];
}
