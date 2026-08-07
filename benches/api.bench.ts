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
import { Collector, buildResult } from '../lib/api/result.ts';
import { resolveReporting, toConfigOptions } from '../lib/api/options.ts';
import { openFeed, eventReporter } from '../lib/api/events.ts';
import { run, runSession, search } from '../lib/api/index.ts';
import type { Config } from '../lib/types.ts';
import type { TestDetails } from '../lib/reporters/types.ts';

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
    stdout: { write: () => {} },
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

Deno.bench('api: search() one file, no browser', { group: 'api-scan', n: 20 }, async () => {
  await search({ inputs: [FIXTURE] });
});

// ─── in-memory bookkeeping ───────────────────────────────────────────────────
// What the API adds per test on top of the runner: one projection and one array push.

const details = (index: number): TestDetails => ({
  status: index % 10 === 0 ? 'failed' : 'passed',
  fullName: ['Bench', `case ${index}`],
  runtime: 1,
  assertions: index % 10 === 0 ? [{ passed: false, todo: false, actual: 1, expected: 2 }] : [],
});

Deno.bench('api: collector records 10k testEnd events', { group: 'api-collect' }, () => {
  const collector = new Collector();
  for (let index = 0; index < 10_000; index++) {
    collector.onTestEnd(undefined as unknown as Config, details(index));
  }
});

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
          testCount: 10_000,
          passCount: 9_000,
          failCount: 1_000,
          skipCount: 0,
          todoCount: 0,
          errorCount: 1_000,
        },
        failedFiles: new Set<string>(),
        failedTests: [],
        coverage: null,
        aborted: false,
      },
    },
  }) as unknown as Config;

Deno.bench('api: buildResult over 10k tests', { group: 'api-collect' }, () => {
  const collector = new Collector();
  for (let index = 0; index < 10_000; index++) {
    collector.onTestEnd(undefined as unknown as Config, details(index));
  }
  buildResult(
    benchConfig(),
    { exitCode: 1, durationMs: 100, startedAt: 0, finishedAt: 100 },
    collector,
    null,
  );
});

Deno.bench('api: resolve options + reporters', { group: 'api-collect' }, () => {
  const reporting = resolveReporting({ inputs: [FIXTURE], reporter: 'tap' });
  toConfigOptions({ inputs: [FIXTURE], reporter: 'tap' }, reporting);
});

// The event path's own cost, with no browser in the way: 10k emits through the feed while a
// consumer drains it as fast as it can. Now measuring `Stream.channel` rather than the local
// queue it replaced — the number to watch if the shared implementation ever grows an allocation
// per event, since every push source in the codebase would pay it.
Deno.bench('api: channel round-trips 10k events', { group: 'api-collect' }, async () => {
  const channel = openFeed();
  const drained = (async () => {
    let seen = 0;
    for await (const _event of channel.stream) seen++;

    return seen;
  })();

  // One config, hoisted: the reporter ignores it, and rebuilding it per event would price the
  // fixture rather than the channel.
  const config = benchConfig();
  const reporter = eventReporter(channel);
  for (let index = 0; index < 10_000; index++) reporter.onTestEnd?.(config, details(index));
  channel.close();
  await drained;
});
