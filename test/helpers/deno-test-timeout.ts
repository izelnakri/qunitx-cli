/**
 * Per-test deadline for the deno lane, injected via `deno test --preload`.
 *
 * The node lane passes `--test-timeout`, so a hung test fails by name and the worker moves on.
 * Deno has no equivalent flag (still absent as of 2.9) and no per-test timeout in `Deno.test`
 * options, so before this a hang consumed the entire GHA job — 25 minutes, cancelled, with no
 * indication of *which* test was stuck beyond deno's "has been running for over (16m0s)"
 * warnings. `--preload` runs before the main module in every test worker, which is the one hook
 * available to wrap `Deno.test` and race each test against a deadline.
 *
 * Scope: this bounds test functions. A hang at module top-level, or between tests, is still on
 * the job-level timeout — the runner's outer net.
 *
 * `Deno.test.ignore` / `.only` are copied through unwrapped: `ignore` never executes, and
 * `only` is a local debugging affordance that never reaches CI.
 */

import { PER_TEST_TIMEOUT_MS } from './per-test-timeout.ts';

type TestFn = (...args: unknown[]) => unknown;
type TestOptions = { name?: string; fn?: TestFn };

const originalTest = Deno.test;
const register = originalTest.bind(Deno) as (...args: unknown[]) => unknown;

/**
 * Wraps a test fn so it rejects at the deadline instead of hanging forever. The rejection is
 * what deno's reporter turns into a normal named failure, letting the rest of the file run.
 */
function withDeadline(name: string, fn: TestFn): TestFn {
  return async function (this: unknown, ...args: unknown[]) {
    let timer: number | undefined;
    try {
      return await Promise.race([
        (async () => await fn.apply(this, args))(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`qunitx: test exceeded ${PER_TEST_TIMEOUT_MS}ms — ${name}`)),
            PER_TEST_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/**
 * Re-dispatches every `Deno.test` overload with the test fn wrapped:
 * `(fn)`, `(name, fn)`, `(options)`, `(options, fn)`, `(name, options, fn)`.
 * qunitx itself uses `(options)` with `options.fn`; the rest are covered so a hand-written
 * `Deno.test` in this repo is bounded too. Anything unrecognised passes straight through —
 * an unbounded test beats a harness that throws on a shape we didn't anticipate.
 */
function wrappedTest(...args: unknown[]): unknown {
  const [first, second, third] = args;

  if (typeof first === 'function') {
    return register(withDeadline(first.name || 'anonymous', first as TestFn));
  }
  if (typeof first === 'string' && typeof second === 'function') {
    return register(first, withDeadline(first, second as TestFn));
  }
  if (typeof first === 'string' && typeof third === 'function') {
    return register(first, second, withDeadline(first, third as TestFn));
  }
  if (typeof first === 'object' && first !== null) {
    const options = first as TestOptions;
    const name = options.name ?? 'anonymous';
    if (typeof second === 'function') {
      return register(options, withDeadline(name, second as TestFn));
    }
    if (typeof options.fn === 'function') {
      return register({ ...options, fn: withDeadline(name, options.fn) });
    }
  }
  return register(...args);
}

// Carry over `ignore`/`only`/etc. so the namespace keeps its full surface.
Object.assign(wrappedTest, originalTest);
Deno.test = wrappedTest as unknown as typeof Deno.test;
