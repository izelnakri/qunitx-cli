/**
 * Benchmarks HTTP + WebSocket server construction cost.
 * This runs on every test-runner startup, so its cost adds directly to time-to-first-test.
 *
 * Note: port-binding latency (listen + close) is intentionally not benchmarked here —
 * it is affected by OS TCP TIME_WAIT state accumulated by the test suite that runs
 * before bench-check in `make release`, making it unreliable as a regression gate.
 */
import HTTPServer from "../lib/servers/http.ts";

Deno.bench("server: create HTTPServer instance", {
  group: "server",
  baseline: true,
}, () => {
  // deno-lint-ignore no-new
  new HTTPServer();
});
