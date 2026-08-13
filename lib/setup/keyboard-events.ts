import { listenToKeyboardKey } from '../utils/listen-to-keyboard-key.ts';
import type { WatchSession } from '../commands/run.ts';

/**
 * Binds watch-mode keyboard shortcuts to the session's verbs: `qq` aborts, `qa` runs all, `qf`
 * re-runs the last failures, `ql` repeats the last run.
 *
 * Nothing but the binding lives here. What each shortcut *means* is a method on
 * {@link WatchSession}, so the JS API and a future TUI get the same four behaviours without
 * reimplementing them — and a rerun asked for by a keystroke now goes through the same serializer
 * as the file watcher's, which is what the session's one-run-at-a-time guarantee assumed all along.
 *
 * ```ts
 * import * as KeyboardEvents from './keyboard-events.ts';
 * import type { WatchSession } from '../commands/run.ts';
 *
 * // Defined, not invoked: attaches stdin key listeners.
 * function enableShortcuts(session: WatchSession) {
 *   KeyboardEvents.setup(session); // qq abort · qa run all · qf last failed · ql last run
 * }
 * ```
 * @returns {void}
 */
export function setup(session: WatchSession): void {
  // Every handler discards its promise: a keystroke is nobody's `await`, and an unhandled
  // rejection from a rerun would take the process down. Reruns report themselves through the
  // reporters either way, so there is nothing here left to say.
  listenToKeyboardKey('qq', () => session.abort());
  listenToKeyboardKey('qa', () => void session.runAll().catch(() => {}));
  listenToKeyboardKey('qf', () => void session.runFailed().catch(() => {}));
  listenToKeyboardKey('ql', () => {
    session.abort();
    void session.run(session.config.state.group.lastRanFiles ?? undefined).catch(() => {});
  });
}
