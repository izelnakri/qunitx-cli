import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import { outputDir } from '../helpers/temp-dir.ts';
import * as QUnitX from '../../lib/api/index.ts';
import type { UserRunOptions } from '../../lib/api/options.ts';
import type { RunResult } from '../../lib/api/test.ts';
import type { WatchSession } from '../../lib/api/watch.ts';
import type { TestSession } from '../../lib/api/session.ts';

// The API tests are the only ones that drive a browser *in this process* rather than through
// `node cli.ts`. Two things have to be arranged by hand as a result:
//
//   1. The Chrome semaphore. The shell helper acquires a permit for every CLI invocation it
//      spawns; there is no spawn here, so these helpers take the permit themselves. Without it
//      the API suite launches browsers outside the run-wide concurrency cap.
//   2. A private output directory per run, so concurrent test files cannot overwrite each
//      other's bundle. The shell helper appends `--output=tmp/run-<uuid>` for the same reason.

/**
 * Runs the API against `options` with a permit held and a private output directory, and cleans
 * both up afterwards.
 *
 * ```ts
 * import { apiRun } from './helpers.ts';
 *
 * // Defined, not invoked: launches a real browser.
 * async function green() {
 *   const result = await apiRun({ inputs: ['test/fixtures/passing-tests.ts'] });
 *   return result.ok;
 * }
 * ```
 */
export async function apiRun(options: UserRunOptions): Promise<RunResult> {
  await using output = outputDir('api-run');
  const permit = await acquireBrowser();
  try {
    return await QUnitX.test({ output: output.path, ...options });
  } finally {
    permit.release();
  }
}

/**
 * Starts a watch session with a permit held, hands it to `body`, and closes it — releasing the
 * permit only once the browser is actually down, since a session holds one for its whole life.
 *
 * ```ts
 * import { withWatch } from './helpers.ts';
 *
 * // Defined, not invoked: launches a real browser and leaves it watching.
 * async function firstRunCount() {
 *   return await withWatch({}, (session) => session.initial.counts.total);
 * }
 * ```
 */
export async function withWatch<T>(
  options: UserRunOptions,
  body: (session: WatchSession) => Promise<T> | T,
): Promise<T> {
  await using output = outputDir('api-watch');
  const permit = await acquireBrowser();
  const session = await QUnitX.watch({ output: output.path, ...options });
  try {
    return await body(session);
  } finally {
    await session.close();
    permit.release();
  }
}

/**
 * Starts a run session with a permit held, hands it to `body`, and closes it.
 *
 * ```ts
 * import { withTestSession } from './helpers.ts';
 *
 * // Defined, not invoked: launches a real browser.
 * async function eventCount() {
 *   return await withTestSession({}, async (session) => (await session.result()).counts.total);
 * }
 * ```
 */
export async function withTestSession<T>(
  options: UserRunOptions,
  body: (session: TestSession) => Promise<T> | T,
): Promise<T> {
  await using output = outputDir('api-session');
  const permit = await acquireBrowser();
  const session = await QUnitX.testSession({ output: output.path, ...options });
  try {
    return await body(session);
  } finally {
    await session.close();
    permit.release();
  }
}

/** Collects everything written through a run's `console`, for asserting on reporter output. */
export function captureStream(): { write(text: string): void; text(): string } {
  const chunks: string[] = [];

  return {
    write: (text: string) => void chunks.push(text),
    text: () => chunks.join(''),
  };
}
