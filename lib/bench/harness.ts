// The in-page half of `qunitx bench`: `Deno.bench`'s API and measurement, run wherever the bench
// file runs. It is serialized into the page with `Function.prototype.toString`, so
// `installBench` must stay self-contained: no imports, no closures over this module.

/**
 * A benchmark, as `Deno.bench` takes one. `permissions` and `sanitizeExit` are Deno's and accepted
 * so the same file runs in both; a browser has no permissions to grant.
 *
 * ```ts
 * const definition: BenchDefinition = { name: 'parse', group: 'url', baseline: true, fn: () => new URL('https://a.b') };
 * ```
 */
export interface BenchDefinition {
  /** What it measures: one iteration, given the bench's context. */
  fn: (b: BenchContext) => unknown;
  /** Its name; a named function's name when not given. */
  name: string;
  /** Skipped, and left out of the report. */
  ignore?: boolean;
  /** Run only the benches marked `only`; the run then fails, so it is not left in by mistake. */
  only?: boolean;
  /** Benches of one group are compared with each other in the report's summary. */
  group?: string;
  /** The bench the rest of its group is compared against. */
  baseline?: boolean;
  /** Exactly this many measured iterations, each timed on its own. */
  n?: number;
  /** Exactly this many iterations before measuring. */
  warmup?: number;
  /** Deno's; accepted and ignored. */
  permissions?: unknown;
  /** Deno's; accepted and ignored. */
  sanitizeExit?: boolean;
}

/**
 * What a bench's `fn` is given: its name, the file it is in, and `start()` / `end()` to time only
 * part of an iteration.
 *
 * ```ts
 * import type { BenchContext } from './harness.ts';
 *
 * function measured(b: BenchContext) {
 *   const list = Array.from({ length: 100 }, (_, index) => index);
 *   b.start();
 *   list.reverse();
 *   b.end();
 * }
 * ```
 */
export interface BenchContext {
  /** The bench's name. */
  name: string;
  /** The file it was declared in, as a URL. */
  origin: string;
  /** Starts this iteration's clock: what came before is setup. */
  start(): void;
  /** Stops it: what comes after is teardown. */
  end(): void;
}

/**
 * A bench's measurement, exactly as `deno bench --json` reports it: `n` samples, and the time of
 * one iteration — its mean, extremes and percentiles — in nanoseconds.
 *
 * ```ts
 * const stats: BenchStats = {
 *   n: 250, min: 180.2, max: 809.6, avg: 200.1, p75: 199.6, p99: 304.3, p995: 364.4, p999: 809.6,
 *   highPrecision: true, usedExplicitTimers: false,
 * };
 * ```
 */
export interface BenchStats {
  /** Samples taken. */
  n: number;
  /** The fastest sample's time per iteration. */
  min: number;
  /** The slowest's. */
  max: number;
  /** The mean time per iteration. */
  avg: number;
  /** 75th percentile. */
  p75: number;
  /** 99th percentile. */
  p99: number;
  /** 99.5th percentile. */
  p995: number;
  /** 99.9th percentile. */
  p999: number;
  /** Whether the clock was precise to microseconds: a cross-origin-isolated page's is. */
  highPrecision: boolean;
  /** Whether `start()` and `end()` timed part of each iteration. */
  usedExplicitTimers: boolean;
}

/**
 * One bench's outcome, in `deno bench --json`'s shape: measured, or failed with its error.
 *
 * ```ts
 * const failed: BenchEntry = {
 *   origin: 'file:///a.bench.ts', group: null, name: 'parse', baseline: false,
 *   results: [{ failed: { name: 'Error', message: 'boom', stack: 'Error: boom' } }],
 * };
 * ```
 */
export interface BenchEntry {
  /** The file it is in, as a URL. */
  origin: string;
  /** Its group, or null. */
  group: string | null;
  /** Its name. */
  name: string;
  /** Whether its group is compared against it. */
  baseline: boolean;
  /** One result: its measurement, or the error it threw. */
  results: ({ ok: BenchStats } | { failed: { name: string; message: string; stack: string } })[];
}

/**
 * How long to measure, in milliseconds: warming up, each sample at least, and each bench in all;
 * and the fewest and most samples a bench takes.
 *
 * ```ts
 * const timing: BenchTiming = { warmupMs: 100, sampleMs: 10, budgetMs: 500, minSamples: 10, maxSamples: 100_000 };
 * ```
 */
export interface BenchTiming {
  /** Iterations run, unmeasured, for this long first, so the JIT settles. */
  warmupMs: number;
  /** A sample is a batch of iterations at least this long, so the clock's grain is a rounding error. */
  sampleMs: number;
  /** Samples are taken for this long. */
  budgetMs: number;
  /** At least this many samples, however long they take. */
  minSamples: number;
  /** At most this many. */
  maxSamples: number;
}

/**
 * Installs `bench` (and what `Deno.bench` is compiled to) on `globalThis`, and returns the run:
 * every bench declared so far, measured in turn, ungrouped first and then each group, as
 * `deno bench` orders them. `filter` keeps the benches whose name contains it, or matches it when
 * it is `/a regex/`. `hooks.started` and `hooks.finished` are told of each bench as it starts and
 * ends, between measurements.
 *
 * ```ts
 * import { installBench } from './harness.ts';
 *
 * const harness = installBench({ origin: 'file:///a.bench.ts', highPrecision: true, timing: { warmupMs: 1, sampleMs: 1, budgetMs: 5, minSamples: 2, maxSamples: 10 } });
 * harness.bench('sum', () => 1 + 1);
 * const { benches } = await harness.run({});
 * 'ok' in benches[0].results[0]; // true
 * ```
 */
export function installBench(settings: {
  origin: string;
  highPrecision: boolean;
  timing: BenchTiming;
}): {
  bench: (...args: unknown[]) => void;
  run: (options: {
    filter?: string;
    hooks?: {
      started?: (name: string) => unknown;
      finished?: (outcome: BenchEntry) => unknown;
    };
  }) => Promise<{ benches: BenchEntry[]; onlyUsed: boolean; declared: number }>;
} {
  const definitions: BenchDefinition[] = [];
  // Every iteration's result is kept here, so the optimizer cannot remove the work measured.
  let sink: unknown;

  function bench(...args: unknown[]): void {
    const [first] = args;
    if (first === null || !['function', 'string', 'object'].includes(typeof first)) {
      throw new TypeError('bench: expected a function, a name and a function, or a definition');
    }
    // Deno's five forms: (fn), (name, fn), (name, options, fn), (options, fn) and (definition).
    const options = (args.slice(0, 2).find((arg) => arg !== null && typeof arg === 'object') ??
      {}) as Partial<BenchDefinition>;
    const fn = (args.find((arg) => typeof arg === 'function') ??
      options.fn) as BenchDefinition['fn'];
    const definition = {
      ...options,
      fn,
      name: typeof first === 'string' ? first : (options.name ?? fn?.name),
    };
    if (typeof definition.fn !== 'function') throw new TypeError('bench: the bench has no fn');
    if (typeof definition.name !== 'string' || definition.name === '') {
      throw new TypeError("bench: the bench's name can't be empty");
    }
    for (const count of ['n', 'warmup'] as const) {
      const value = definition[count];
      if (value !== undefined && !(Number.isInteger(value) && value >= (count === 'n' ? 1 : 0))) {
        throw new TypeError(`bench: "${definition.name}": ${count} must be a whole number`);
      }
    }
    definitions.push(definition as BenchDefinition);
  }

  async function measure(definition: BenchDefinition): Promise<BenchStats> {
    const { timing } = settings;
    // One iteration's start() and end(), kept in an object the context's methods write to.
    // `ignored`: they were dropped for being finer than the clock, and the whole iteration is timed.
    const clock: { started: number | null; elapsed: number | null; ignored: boolean } = {
      started: null,
      elapsed: null,
      ignored: false,
    };
    let explicit = false;
    const context: BenchContext = {
      name: definition.name,
      origin: settings.origin,
      start() {
        if (clock.ignored) return;
        if (clock.started !== null)
          throw new Error('bench: start() was already called this iteration');
        explicit = true;
        clock.started = performance.now();
      },
      end() {
        if (clock.ignored) return;
        const now = performance.now();
        if (clock.started === null) throw new Error('bench: end() was called before start()');
        clock.elapsed = now - clock.started;
      },
    };
    // Async when an iteration hands back a promise; awaited only then, so a synchronous bench is
    // not timed with a microtask hop on every call.
    const probe = definition.fn(context);
    const isAsync = probe !== null && typeof (probe as Promise<unknown>)?.then === 'function';
    sink = isAsync ? await probe : probe;
    if (explicit && clock.elapsed === null)
      throw new Error('bench: start() was called without end()');
    // One iteration timed on its own: by start() and end() when it calls them.
    const once = async (): Promise<number> => {
      clock.started = null;
      clock.elapsed = null;
      const before = performance.now();
      sink = isAsync ? await definition.fn(context) : definition.fn(context);
      const after = performance.now();
      if (explicit && clock.elapsed === null) {
        throw new Error('bench: start() and end() must both be called in every iteration');
      }
      // Number(): TypeScript cannot see that fn() set it through the context.
      return explicit ? Number(clock.elapsed) : after - before;
    };
    const batch = async (count: number): Promise<number> => {
      const before = performance.now();
      if (isAsync) for (let index = 0; index < count; index++) sink = await definition.fn(context);
      else for (let index = 0; index < count; index++) sink = definition.fn(context);
      return performance.now() - before;
    };

    if (definition.warmup !== undefined) {
      for (let index = 0; index < definition.warmup; index++) await once();
    } else {
      // Once at least, then until the warmup's time is up.
      const until = performance.now() + timing.warmupMs;
      for (await once(); performance.now() < until; await once());
    }

    // Batches long enough that the clock's grain is a rounding error, grown by doubling.
    const batched = async (): Promise<number[]> => {
      let size = 1;
      for (
        let time = await batch(1);
        time < timing.sampleMs && size < 1e8;
        time = await batch(size)
      ) {
        size = time > 0 ? Math.min(size * 4, Math.ceil((size * timing.sampleMs) / time)) : size * 4;
      }
      const samples: number[] = [];
      for (
        const until = performance.now() + timing.budgetMs;
        samples.length < timing.minSamples ||
        (samples.length < timing.maxSamples && performance.now() < until);
        samples.push((await batch(size)) / size)
      );
      return samples;
    };

    let perIteration: number[] = [];
    if (definition.n !== undefined || explicit) {
      // Counted, or timed by start() and end(): every sample is one iteration.
      const until = performance.now() + timing.budgetMs;
      const enough = () =>
        definition.n !== undefined
          ? perIteration.length >= definition.n
          : perIteration.length >= timing.maxSamples ||
            (perIteration.length >= timing.minSamples && performance.now() >= until);
      for (; !enough(); perIteration.push(await once()));
      // As `deno bench` does: start() and end() around less than 10µs are finer than the clock, so
      // they are ignored and whole iterations are timed in batches instead.
      const mean = perIteration.reduce((sum, value) => sum + value, 0) / perIteration.length;
      if (explicit && definition.n === undefined && mean < 0.01) {
        clock.ignored = true;
        perIteration = await batched();
      }
    } else {
      perIteration = await batched();
    }

    const sorted = perIteration.map((ms) => ms * 1e6).sort((a, b) => a - b);
    const at = (fraction: number) =>
      sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
    return {
      n: sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
      p75: at(0.75),
      p99: at(0.99),
      p995: at(0.995),
      p999: at(0.999),
      highPrecision: settings.highPrecision,
      usedExplicitTimers: explicit,
    };
  }

  async function run(options: {
    filter?: string;
    hooks?: {
      started?: (name: string) => unknown;
      finished?: (outcome: BenchEntry) => unknown;
    };
  }): Promise<{ benches: BenchEntry[]; onlyUsed: boolean; declared: number }> {
    const pattern = /^\/(.*)\/([a-z]*)$/.exec(options.filter ?? '');
    const regex = pattern ? new RegExp(pattern[1], pattern[2]) : null;
    const matches = (name: string) =>
      !options.filter || (regex ? regex.test(name) : name.includes(options.filter));
    const onlyUsed = definitions.some((definition) => definition.only);
    const chosen = definitions.filter(
      (definition) =>
        !definition.ignore && (!onlyUsed || definition.only) && matches(definition.name),
    );
    // Ungrouped first, then each group in the order it first appears, as `deno bench` runs them.
    const groups = [...new Set(chosen.map((definition) => definition.group ?? null))];
    const ordered = [null, ...groups.filter((group) => group !== null)].flatMap((group) =>
      chosen.filter((definition) => (definition.group ?? null) === group),
    );
    const benches: BenchEntry[] = [];
    for (const definition of ordered) {
      await options.hooks?.started?.(definition.name);
      const result = await measure(definition).then(
        (ok): BenchEntry['results'][number] => ({ ok }),
        (error) => {
          const thrown = error instanceof Error ? error : new Error(String(error));
          // Firefox and Safari leave the error's own line out of its stack; V8 starts with it.
          const title = `${thrown.name}: ${thrown.message}`;
          const stack = thrown.stack ?? '';
          return {
            failed: {
              name: thrown.name,
              message: thrown.message,
              stack: stack.startsWith(title) ? stack : `${title}\n${stack}`.trimEnd(),
            },
          };
        },
      );
      const outcome: BenchEntry = {
        origin: settings.origin,
        group: definition.group ?? null,
        name: definition.name,
        baseline: definition.baseline ?? false,
        results: [result],
      };
      benches.push(outcome);
      await options.hooks?.finished?.(outcome);
    }
    void sink;
    return { benches, onlyUsed, declared: definitions.length };
  }

  return { bench, run };
}
