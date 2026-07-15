/**
 * The per-test deadline, shared by both lanes so a hung test costs the same wherever it runs.
 *
 * Node consumes it as `node --test --test-timeout=N`: node:test fails any test whose runtime
 * exceeds this and force-completes its subtests, so a hung test surfaces by name in the spec
 * output and the worker moves on cleanly — no zombies, no SIGKILL hammer, no whole-phase loss.
 * Deno has no equivalent flag, so `test/helpers/deno-test-timeout.ts` enforces the same number
 * by wrapping `Deno.test`. Both import this module rather than passing the value around: a
 * second copy of the literal is exactly how the two lanes would drift apart unnoticed.
 *
 * Sized to comfortably exceed the slowest observed healthy test. Watch-rerun tests are the long
 * tail: per-test wall clock has been observed up to 120 s on slow CI runners under contention
 * (Windows + concurrent Chrome launches). Daemon tests' rapid-stop+start used to peak at 120 s
 * pre-leak-fix; current healthy max is ~15 s. 300 s = 5 min ≈ 2.5× the observed slow tail leaves
 * room for the runner's natural tail variance without misfiring on real-but-slow runs. Anything
 * past 5 min is genuinely stuck.
 *
 * Below this the per-call `DEFAULT_EXEC_TIMEOUT_MS = 180_000` in test/helpers/shell.ts cuts off
 * individual cli invocations; this is the outer safety net for the test itself.
 *
 * Above this, GitHub Actions' job-level `timeout-minutes` (15 on ubuntu, 25 on macos/windows in
 * ci.yml) is the ultimate fallback for anything neither lane's deadline can see — a hang at
 * module top-level, or between tests, rather than inside a test fn.
 */
export const PER_TEST_TIMEOUT_MS = 300_000;
