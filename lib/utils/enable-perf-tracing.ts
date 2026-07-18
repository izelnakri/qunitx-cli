// Side-effect module: opts the CLI into `--trace-perf` / QUNITX_TRACE_PERF tracing.
// Must be imported before chrome-prelaunch.ts and browser.ts so the milestones those
// modules emit as they evaluate are still captured — a call from cli.ts's body would
// run after every static import had already evaluated, losing exactly the startup
// measurements the flag exists for.
// Kept out of perf-logger.ts itself so importing the logger stays free of the decision:
// the JS API pulls in the same dep graph and must never trace into its host's stderr.
import { enablePerfTracing } from './perf-logger.ts';

enablePerfTracing();
