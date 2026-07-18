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
 * Tracing is OFF until `enablePerfTracing()` is called, and only the CLI calls it —
 * via the side-effect import at the top of `cli.ts`, which runs before the modules
 * that trace their own evaluation. Reading argv and the environment at module load
 * instead would make the decision for anyone who merely imports this dep graph: an
 * embedded run inside a host that traces itself would narrate qunitx's internals
 * into that host's stderr, which it never asked for. Same reason `startPrelaunch()`
 * is explicit rather than a module-eval side effect.
 *
 * All perfLog() calls stay zero-overhead no-ops while tracing is disabled — one
 * boolean check, no per-call argument evaluation.
 */

let isPerfTracing = false;
let processStart = 0;

/**
 * Turns perf tracing on when `argv` or the environment asks for it. Called once by `cli.ts`;
 * the JS API deliberately never calls it, so an embedded run is silent regardless of how the
 * host process was invoked.
 * @param {string[]} argv
 */
export function enablePerfTracing(argv: string[] = process.argv): void {
  isPerfTracing = argv.includes('--trace-perf') || Boolean(process.env.QUNITX_TRACE_PERF);
  if (isPerfTracing) processStart = Date.now();
}

/**
 * Writes a timestamped perf trace line to stderr when tracing is active.
 * @param {string} label
 * @param {...*} details
 */
export function perfLog(label: string, ...details: unknown[]): void {
  if (!isPerfTracing) return;
  const elapsed = Date.now() - processStart;
  const suffix = details.length ? ' ' + details.join(' ') : '';
  process.stderr.write(`[perf +${elapsed}ms] ${label}${suffix}\n`);
}
