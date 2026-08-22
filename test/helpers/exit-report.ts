/** Printed only when the process could NOT exit. Its absence from stdout is the pass. */
export const LEAKED_MARKER = 'LEAKED-HANDLES';

/**
 * Reports the handles that stopped this process from exiting — and prints nothing when it can.
 *
 * The exit fixtures all promise the same thing: after `close()` (or a settled Task), a script that
 * did nothing else is free to end. What they USED to assert was a census taken the instant the
 * await returned, which is a strictly stronger claim than the contract and not one the runtime
 * makes: a handle still winding down is not a leaked handle. `browser.close()` resolves when
 * playwright has seen the child's `close` event, but the OS has more to do afterwards, and on
 * Windows that tail is long enough to be visible — a `ProcessWrap` in the census of a process that
 * then exited cleanly, one line later, with code 0. It failed the v0.35.0 release tag that way.
 *
 * So this asks the question the contract actually answers. The timer is UNREF'D, which means it
 * cannot hold the loop open by itself and fires only if something else already is:
 *
 * - the process can exit → node ends before the deadline, the callback never runs, stdout is clean
 * - something leaks → the loop is still alive at the deadline, and the offenders are named
 *
 * Transient teardown cannot produce a false positive, because a transient handle is gone long
 * before the deadline and takes the process with it. A real leak cannot escape, because a leak is
 * exactly "the loop is still alive with nothing left to do".
 *
 * Exits rather than hanging on: the caller would otherwise sit until its spawn timeout and report
 * a timeout instead of the handle names, turning a precise failure into a slow vague one.
 *
 * ```ts
 * import { LEAKED_MARKER, reportLeakedHandles } from './exit-report.ts';
 *
 * LEAKED_MARKER; // 'LEAKED-HANDLES' — what the assertion greps stdout for
 * reportLeakedHandles(0); // armed, but unref'd: this process still exits immediately
 * ```
 */
export function reportLeakedHandles(deadlineMs: number = 5_000): void {
  // Generous on purpose. It is not a threshold the pass path depends on — a process that can exit
  // never reaches it at all — so the only thing a longer wait costs is how fast a REAL leak is
  // reported, and the only thing a shorter one risks is calling a slow teardown a leak.
  const timer = setTimeout(() => {
    console.log(`${LEAKED_MARKER} ${JSON.stringify(process.getActiveResourcesInfo())}`);
    process.exit(0);
  }, deadlineMs);

  timer.unref();
}
