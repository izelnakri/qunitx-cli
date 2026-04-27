/**
 * Daemon-routed CLI benchmark — measures the headline value proposition of
 * `qunitx daemon`: cli invocation routed through the persistent Unix-socket
 * daemon, served from a warm Chrome and a warm esbuild incremental context.
 *
 * One bench, deliberately. Cold-spawn / cache-miss / concurrent-multi-file
 * variants were considered and rejected: cold-spawn is dominated by Chrome
 * launch noise and bench-check's threshold (~26%) wouldn't reliably detect
 * realistic module-loading regressions; cache-miss appears as an *improvement*
 * if the cache invalidation breaks (wrong-direction signal); concurrent
 * multi-file mostly retests run.ts's existing concurrent-group orchestration
 * without daemon-specific signal.
 *
 * The remaining bench catches the regressions that actually matter:
 *   - cli.ts module-loading bloat (lazy-load reverted) — adds ~50–80ms
 *   - daemon dispatch / IPC overhead (run-queue contention, NDJSON parser)
 *   - run.ts daemon path breakage (e.g. browser re-launched per run)
 *   - esbuild context cache-key bug (context recreated every iteration)
 *   - setupBrowser per-run cost (page + new HTTPServer + bind)
 *
 * Compare against `cli: e2e run (1 passing test file)` in e2e.bench.ts —
 * daemon is expected to be 3-4× faster. A regression here that shrinks the
 * gap is the signal that the daemon's value prop has eroded.
 *
 * Note: this file is run in an isolated subprocess by scripts/check-benchmarks.ts
 * (used by `bench:check` / `bench:update` / `make bench`), so the persistent
 * daemon started below cannot affect other bench files there. It is intentionally
 * NOT added to the in-process `bench` task, where top-level daemon startup would
 * leak into e2e.bench.ts numbers. The daemon's 30-min idle timeout handles
 * cleanup if this file's process exits before manual `qunitx daemon stop`.
 */
import { mkdir } from 'node:fs/promises';

const PROJECT_ROOT = new URL('..', import.meta.url).pathname;
const FIXTURE = 'test/helpers/passing-tests.ts';

await mkdir(`${PROJECT_ROOT}/tmp`, { recursive: true });

function spawnCLI(args: string[]): Promise<{ code: number }> {
  const id = crypto.randomUUID();
  return new Deno.Command('node', {
    args: ['cli.ts', ...args, `--output=tmp/bench-run-${id}`],
    cwd: PROJECT_ROOT,
    env: { ...Deno.env.toObject(), FORCE_COLOR: '0' },
    stdout: 'null',
    stderr: 'null',
  }).output();
}

// Defensive: any leftover daemon from a previous bench run would falsify the
// "fresh cold spawn" we're about to do. `daemon stop` is idempotent — returns
// fast when no daemon is running.
await spawnCLI(['daemon', 'stop']);
// Start the daemon and prime the esbuild context cache against the same
// fixture the bench iterates on. Subsequent measured iterations hit the
// warm cache — the actual thing the daemon is supposed to optimize.
await spawnCLI(['daemon', 'start']);
await spawnCLI([FIXTURE]);

Deno.bench(
  'cli-daemon: e2e run (1 passing test file, warm)',
  {
    group: 'cli-daemon',
    baseline: true,
    n: 5,
    warmup: 0,
  },
  async () => {
    await spawnCLI([FIXTURE]);
  },
);
