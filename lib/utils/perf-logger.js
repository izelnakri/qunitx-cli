/**
 * Performance tracing logger for qunitx internals.
 *
 * Enable by passing `--trace-perf` to any run command:
 *   qunitx test/foo.js --trace-perf
 *
 * All perfLog() calls are zero-overhead no-ops when tracing is disabled —
 * the flag is read once at module load time, no per-call argument evaluation.
 */

export const isPerfTracing = process.argv.includes('--trace-perf');

const processStart = isPerfTracing ? Date.now() : 0;

/**
 * Writes a timestamped perf trace line to stderr when --trace-perf is active.
 * @param {string} label
 * @param {...*} details
 */
export function perfLog(label, ...details) {
  if (!isPerfTracing) return;
  const elapsed = Date.now() - processStart;
  const suffix = details.length ? ' ' + details.join(' ') : '';
  process.stderr.write(`[perf +${elapsed}ms] ${label}${suffix}\n`);
}
