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
 * so the timeout can name what it gave up on: resolves with the names still pending, empty when
 * everything settled in time.
 *
 * ```ts
 * const browserClose = Promise.resolve();
 * const serverClose: Promise<void> | undefined = undefined; // e.g. connections.server?.close()
 *
 * await closeWithGrace({ browser: browserClose, server: serverClose }); // [] — everything settled
 * await closeWithGrace({ wedged: Promise.reject(new Error('boom')) }, 50); // [] — a rejection is settled
 * ```
 */
export function closeWithGrace(
  closes: Readonly<Record<string, Promise<unknown> | null | undefined>>,
  graceMs: number = CLEANUP_GRACE_MS,
): Promise<string[]> {
  const entries = Object.entries(closes);
  const pending = new Set(entries.filter(([, close]) => close).map(([name]) => name));

  return new Promise<string[]>((resolve) => {
    const timer = setTimeout(() => {
      const abandoned = [...pending];
      // NAMING what did not settle, because "cleanup timed out" is a symptom and the handle still
      // held is the bug. This line is the only evidence a CI runner leaves behind, and one that
      // says which close hung turns a week of guessing into a stack trace.
      process.stderr.write(
        `# qunitx: cleanup timed out after ${graceMs} ms — still pending: ${abandoned.join(', ')} — exiting anyway\n`,
      );
      resolve(abandoned);
    }, graceMs);

    Promise.allSettled(
      entries.map(([name, close]) =>
        Promise.resolve(close).finally(() => {
          pending.delete(name);
        }),
      ),
    ).then(() => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}
