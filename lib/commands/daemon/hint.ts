import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Task } from '../../task/index.ts';
import { pathExists } from '../../utils/path-exists.ts';

// Runs faster than this don't benefit enough from the daemon to justify the nag.
const FAST_RUN_THRESHOLD_MS = 500;

const HINT_TEXT =
  '\n\x1b[34mℹ\x1b[39m Tip: export QUNITX_DAEMON=1 for ~2× faster repeated runs ' +
  '(qunitx daemon --help)\n';

const DEFAULT_SENTINEL = path.join(os.homedir(), '.cache', 'qunitx', 'hint-shown');

/**
 * Run context consumed by the daemon-hint eligibility check.
 *
 * ```ts
 * import type * as Hint from './hint.ts';
 *
 * const ctx: Hint.HintContext = { durationMs: 1200, env: {}, isTTY: true };
 * ctx.durationMs; // 1200 — compared against the 500ms fast-run threshold
 * ```
 */
export interface HintContext {
  /** Total wall-clock the run took, in ms. Used against the fast-run threshold. */
  durationMs: number;
  /** True if the run is `--watch` mode (manages its own browser lifecycle — bypass). */
  watch?: boolean;
  /** True if this is the daemon process itself running the work — never hint. */
  daemonMode?: boolean;
  /** Environment to inspect for opt-outs. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override TTY detection (defaults to `process.stderr.isTTY`). Used in tests. */
  isTTY?: boolean;
}

/**
 * Side-effect injection points for `maybePrint` — testing seams.
 *
 * ```ts
 * import type * as Hint from './hint.ts';
 *
 * const lines: string[] = [];
 * const opts: Hint.PrintOpts = { sentinelPath: '/tmp/qunitx-hint-shown', write: (t) => lines.push(t) };
 * opts.sentinelPath; // '/tmp/qunitx-hint-shown'
 * ```
 */
export interface PrintOpts {
  /** Sentinel-file path (defaults to `~/.cache/qunitx/hint-shown`). */
  sentinelPath?: string;
  /** Writer function (defaults to `process.stderr.write`). */
  write?: (text: string) => void;
}

/**
 * Pure check: returns true iff the run context permits the hint. Covers env-var
 * opt-outs, watch / daemon modes (own browser lifecycle), CI (auto-bypassed),
 * the fast-run threshold, and TTY presence. No filesystem access.
 *
 * ```ts
 * import type * as Hint from './hint.ts';
 *
 * // Defined, not invoked: the module resolves a homedir sentinel path at load time.
 * function hintGate(show: typeof Hint.shouldShow) {
 *   return show({ durationMs: 900, env: {}, isTTY: true }); // true — slow local TTY run
 * }
 * ```
 */
export function shouldShow(ctx: HintContext): boolean {
  const env = ctx.env ?? process.env;
  if (ctx.watch) return false;
  if (ctx.daemonMode) return false;
  if (env.CI) return false;
  if (env.QUNITX_DAEMON) return false;
  if (env.QUNITX_NO_DAEMON) return false;
  if (env.QUNITX_HINT_SHOWN) return false;
  if (ctx.durationMs < FAST_RUN_THRESHOLD_MS) return false;
  if (ctx.isTTY === false) return false;
  if (ctx.isTTY === undefined && !process.stderr.isTTY) return false;
  return true;
}

/**
 * Prints the daemon-mode tip to stderr and creates a sentinel file so the tip is
 * shown at most once per machine — users who already know about the daemon
 * shouldn't be nagged. All filesystem I/O is best-effort: a sentinel-write
 * failure just means the hint shows again on the next eligible run.
 *
 * ```ts
 * import type * as Hint from './hint.ts';
 *
 * // Defined, not invoked: reads and writes the ~/.cache/qunitx sentinel file.
 * async function nudge(print: typeof Hint.maybePrint, write: (t: string) => void) {
 *   await print({ durationMs: 1200 }, { write }); // hints at most once per machine
 * }
 * ```
 */
export async function maybePrint(ctx: HintContext, opts: PrintOpts = {}): Promise<void> {
  if (!shouldShow(ctx)) return;
  const sentinel = opts.sentinelPath ?? DEFAULT_SENTINEL;
  if (await pathExists(sentinel)) return;

  (opts.write ?? ((t) => process.stderr.write(t)))(HINT_TEXT);
  // Best-effort: a hint that could not remember it was shown is worth showing twice, never
  // worth failing a run over.
  await Task(async () => {
    await fs.mkdir(path.dirname(sentinel), { recursive: true });
    await fs.writeFile(sentinel, new Date().toISOString());
  }).ignore('daemon hint sentinel write');
}
