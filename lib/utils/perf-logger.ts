/**
 * Performance tracing logger for qunitx internals.
 *
 * Enable per-invocation by passing `--trace-perf`:
 *   qunitx test/foo.js --trace-perf
 *
 * Enable globally (every cli spawn in the current shell or in CI) by setting:
 *   QUNITX_TRACE_PERF=1
 *
 * The env-var path is for diagnosing CI lanes that hang in the middle of a test
 * suite where there's no opportunity to pass a flag — e.g. when the suite spawns
 * dozens of cli invocations via shell helpers, set the env var once at the job
 * level and every cli child inherits it.
 *
 * All perfLog() calls are zero-overhead no-ops when tracing is disabled — the
 * gates are read once at module load time, no per-call argument evaluation.
 */

const isPerfTracing =
  process.argv.includes('--trace-perf') || Boolean(process.env.QUNITX_TRACE_PERF);

const processStart = isPerfTracing ? Date.now() : 0;

/**
 * Writes a timestamped perf trace line to stderr when --trace-perf is active.
 * @param {string} label
 * @param {...*} details
 */
export function perfLog(label: string, ...details: unknown[]): void {
  if (!isPerfTracing) return;
  const elapsed = Date.now() - processStart;
  const suffix = details.length ? ' ' + details.join(' ') : '';
  process.stderr.write(`[perf +${elapsed}ms] ${label}${suffix}\n`);
}
