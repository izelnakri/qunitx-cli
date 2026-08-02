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
 * `connections.server?.close()` flow in without per-call filtering.
 *
 * ```ts
 * const browserClose = Promise.resolve();
 * const serverClose: Promise<void> | undefined = undefined; // e.g. connections.server?.close()
 *
 * await closeWithGrace([browserClose, serverClose]); // resolves once every close settles
 * await closeWithGrace([Promise.reject(new Error('wedged'))], 50); // a failing close cannot wedge it
 * ```
 */
export function closeWithGrace(
  closes: ReadonlyArray<Promise<unknown> | null | undefined>,
  graceMs: number = CLEANUP_GRACE_MS,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      process.stderr.write(`# qunitx: cleanup timed out after ${graceMs} ms — exiting anyway\n`);
      resolve();
    }, graceMs);
    Promise.allSettled(closes).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
