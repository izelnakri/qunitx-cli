/**
 * JS API benchmarks — what a programmatic caller pays, as distinct from what a CLI user pays.
 *
 * Three cost layers, deliberately separated so a regression lands on the one that caused it:
 *
 *   in-process   →  `run()` against a live browser, minus Node boot and module load. The
 *                   difference from `benches/e2e.bench.ts`'s `e2e-1` is the whole reason to
 *                   drive the API rather than spawn the CLI, so it is worth a number.
 *   silent       →  the same run with a reporter attached, to price the reporting fan-out.
 *                   Silence is the API's default, so "does printing cost anything" is the
 *                   question every caller implicitly asks.
 *   scan         →  `search()`, which touches no browser at all — the floor for "what would run".
 *
 * The collector benches are pure CPU: they price the per-test bookkeeping the API adds on top of
 * the runner, at a scale (10k) no real suite reaches, so a per-event regression shows up as a
 * number rather than as a vague sense that large suites got slower.
 */
import { buildResult } from '../lib/api/run.ts';
import { APIReporter } from '../lib/api/reporter.ts';
import { silentConsole } from '../lib/console.ts';
import * as Options from '../lib/api/options.ts';
import { EventsChannel } from '../lib/api/reporter.ts';
import { run, runSession, search } from '../lib/api/index.ts';
import type { Config } from '../lib/types.ts';
import type { ReporterContext, TestDetails } from '../lib/reporters/types.ts';

const PROJECT_ROOT = new URL('..', import.meta.url).pathname;
const FIXTURE = 'test/fixtures/passing-tests.ts';

Deno.chdir(PROJECT_ROOT);

// ─── browser-backed ──────────────────────────────────────────────────────────
// Low iteration counts: each of these launches a real Chrome.

Deno.bench(
  'api: run() one file, silent',
  { group: 'api-run', baseline: true, n: 3, warmup: 1 },
  async () => {
    await run({ inputs: [FIXTURE], output: `tmp/bench-api-${crypto.randomUUID()}` });
  },
);

Deno.bench('api: run() one file, tap reporter', { group: 'api-run', n: 3, warmup: 1 }, async () => {
  await run({
    inputs: [FIXTURE],
    output: `tmp/bench-api-${crypto.randomUUID()}`,
    reporter: 'tap',
    // Into a sink rather than the process stream: the bench measures the fan-out and rendering,
    // not the terminal's ability to absorb it.
    console: silentConsole,
  });
});

// What the event feed costs over the plain value: same run, same browser, one extra reporter and
// one channel push per event. If watching a run is meaningfully slower than waiting one out, the
// session abstraction is not worth having.
Deno.bench(
  'api: runSession() one file, events consumed',
  { group: 'api-run', n: 3, warmup: 1 },
  async () => {
    await using session = await runSession({
      inputs: [FIXTURE],
      output: `tmp/bench-api-${crypto.randomUUID()}`,
    });
    for await (const _event of session);
  },
);

// The realistic call: `search()` with a filter, which is what every `-s Cart` / `--print` does.
//
// Deliberately ONE bench rather than a filtered-vs-unfiltered group. Measured before writing it:
// the matcher is free next to the scan — one file is 4.30ms unfiltered / 4.20ms substring /
// 3.74ms regex, and the whole suite (1380 tests) is 109.5 / 114.2 / 110.3ms. Those spreads are
// under the run-to-run variance, so a comparison group would price nothing and fail CI on noise.
// What this number protects is the scan: parsing files and building match objects.
Deno.bench(
  'api: search() one file with a filter, no browser',
  { group: 'api-scan', n: 20 },
  async () => {
    await search({ inputs: [FIXTURE], filter: 'deepEqual' });
  },
);

// ─── in-memory bookkeeping ───────────────────────────────────────────────────
// What the API adds per test on top of the runner: one projection and one array push.

const details = (index: number): TestDetails => ({
  status: index % 10 === 0 ? 'failed' : 'passed',
  fullName: ['Bench', `case ${index}`],
  runtime: 1,
  assertions: index % 10 === 0 ? [{ passed: false, todo: false, actual: 1, expected: 2 }] : [],
});

Deno.bench('api: collector records 10k testEnd events', { group: 'api-collect' }, () => {
  const collector = new APIReporter();
  for (let index = 0; index < 10_000; index++) {
    collector.onTestEnd(CONTEXT, details(index));
  }
});

// The hooks below ignore their context, but the contract passes one — so build a real one once
// rather than casting at every call. `counts` is the live object a run would mutate.
const CONTEXT: ReporterContext = {
  console: silentConsole,
  counts: {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
    assertionsFailed: 0,
  },
  projectRoot: PROJECT_ROOT,
  output: 'tmp',
  sourceMapDecoder: null,
  daemon: false,
};

const benchConfig = (): Config =>
  ({
    projectRoot: PROJECT_ROOT,
    cwd: PROJECT_ROOT,
    output: 'tmp',
    browser: 'chromium',
    port: 1234,
    extensions: ['js', 'ts'],
    fsTree: { [`${PROJECT_ROOT}${FIXTURE}`]: null },
    state: {
      groupCount: 1,
      group: { lastRanFiles: [`${PROJECT_ROOT}${FIXTURE}`] },
      results: {
        counter: {
          total: 10_000,
          passed: 9_000,
          failed: 1_000,
          skipped: 0,
          todo: 0,
          assertionsFailed: 1_000,
        },
        failedFiles: new Set<string>(),
        failedTests: [],
        coverage: null,
        aborted: false,
      },
    },
  }) as unknown as Config;

Deno.bench('api: buildResult over 10k tests', { group: 'api-collect' }, () => {
  const collector = new APIReporter();
  for (let index = 0; index < 10_000; index++) {
    collector.onTestEnd(CONTEXT, details(index));
  }
  // On the run's reporter list, where `buildResult` looks for it — the same place `Config.setup`
  // puts it, so this measures the real lookup rather than a hand-passed reference.
  const config = benchConfig();
  config.state.reporters = [collector];

  buildResult(config, { exitCode: 1, durationMs: 100, startedAt: 0, finishedAt: 100 });
});

Deno.bench('api: resolve options + reporters', { group: 'api-collect' }, () => {
  // `Options.from` normalizes, validates and builds the reporter set, so this one call is the
  // public-options -> runner-input translation the API does before every run.
  Options.from({ inputs: [FIXTURE], reporter: 'tap' });
});

// The event path's own cost, with no browser in the way: 10k emits through the channel while a
// consumer drains it as fast as it can. Measures `Stream.channel` — the number to watch if the
// shared implementation ever grows an allocation per event, since every push source pays it.
Deno.bench('api: channel round-trips 10k events', { group: 'api-collect' }, async () => {
  const channel = EventsChannel.build();
  // Drained through the Stream's own terminal — the same call an end-user makes on
  // `session.events()`. The emit loop never yields, so this measures 10k enqueues followed by 10k
  // dequeues rather than a true interleave; that is the shape a synchronous reporter produces.
  const drained = (async () => await channel.stream.forEach(() => {}))();

  for (let index = 0; index < 10_000; index++)
    channel.reporter.onTestEnd?.(CONTEXT, details(index));
  channel.close();
  await drained;
});
