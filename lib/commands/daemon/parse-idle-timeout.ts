const UNIT_TO_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * Default daemon idle window: 30 minutes after the last run finishes. Long enough
 * for typical edit/run/edit bursts, short enough that a forgotten daemon reclaims
 * resources without manual intervention.
 */
export const DEFAULT_DAEMON_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Result of {@link parseDaemonIdleTimeout}: the resolved idle window plus an optional human-readable warning the caller should surface to the user. */
export interface ParsedDaemonIdleTimeout {
  /** Milliseconds. `Infinity` when the user opts out of auto-shutdown via `"false"`. */
  ms: number;
  /**
   * Human-readable explanation, set when the env value was malformed. The caller
   * is expected to print this on the spawning CLI's stderr so the user sees it —
   * the daemon process detaches with `stdio: 'ignore'`, so a warning emitted from
   * inside the daemon would be invisible.
   */
  warning: string | null;
}

/**
 * Parses the `QUNITX_DAEMON_IDLE_TIMEOUT` env value. Accepts:
 *
 *   - undefined / empty:           default (30 min), no warning
 *   - `"false"` (case-insensitive): `Infinity` — no auto-shutdown, no warning
 *   - bare number, treated as **minutes**:  `"30"` → 1_800_000
 *   - suffixed number (`ms` | `s` | `m` | `h`): `"1h"`, `"45s"`, `"500ms"`
 *   - fractional values:                       `"0.5h"` → 1_800_000
 *
 * Whitespace and suffix case are tolerated. Anything else (non-numeric, zero or
 * negative, unknown suffix) falls back to the default and returns a warning
 * string — the daemon must not refuse to start over a malformed env var, but the
 * user does need feedback that their override was ignored.
 *
 * Pure: no side effects, no env access — caller passes the raw value.
 */
export function parseDaemonIdleTimeout(value: string | undefined): ParsedDaemonIdleTimeout {
  if (!value) return { ms: DEFAULT_DAEMON_IDLE_TIMEOUT_MS, warning: null };
  if (/^\s*false\s*$/i.test(value)) return { ms: Infinity, warning: null };
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(value);
  if (!match) return invalid(value);
  const n = Number(match[1]);
  if (!(n > 0)) return invalid(value);
  const unit = (match[2] ?? 'm').toLowerCase();
  return { ms: Math.round(n * UNIT_TO_MS[unit]), warning: null };
}

function invalid(value: string): ParsedDaemonIdleTimeout {
  return {
    ms: DEFAULT_DAEMON_IDLE_TIMEOUT_MS,
    warning:
      `⚠ qunitx: QUNITX_DAEMON_IDLE_TIMEOUT=${JSON.stringify(value)} is not a valid duration; ` +
      `using 30-minute default. ` +
      `Accepted: bare number = minutes, "30m", "1h", "45s", "500ms", "false" (no auto-shutdown).`,
  };
}
