import * as Failure from '../../result/failure.ts';
import * as Reporter from '../../reporters/index.ts';
import { closeCompletely } from '../../utils/close-with-grace.ts';
import { Task } from '../../task/index.ts';
import { runQUnitRemotePage } from '../../setup/remote-page.ts';
import { shutdownPrelaunch } from '../../chrome/prelaunch.ts';
import { red } from '../../utils/color.ts';
import type { Browser } from 'playwright-core';
import type { Config } from '../../types.ts';
import type { RunOutcome } from '../test.ts';

// Running suites that already have a page: `qunitx https://objectmodel.js.org/test/`.
//
// Nothing is bundled and no server of ours is involved — the page is opened where it lives and
// QUnit reports through the hook in `lib/setup/remote-page.ts`. What this file owns is the shape
// of a RUN made of such pages: the announce, one page at a time, the summary, and the exit code.

/**
 * A run was given a remote QUnit page and something else as well — a file, or another URL.
 *
 * Both are runnable; what they cannot be is one run. The page reports itself and a bundle reports
 * through this process's own server, so together they would announce twice and plan twice over a
 * single TAP stream. Two commands say exactly what one command cannot.
 *
 * ```ts
 * import { RemotePageMixedWithOtherInputs } from './remote-pages.ts';
 *
 * RemotePageMixedWithOtherInputs({ page: 'https://x/test/', alongside: 2 }).message;
 * // 'https://x/test/ is a suite of its own and runs on its own — 2 other inputs were given too'
 * RemotePageMixedWithOtherInputs({ page: 'https://x/test/', alongside: 1 }).message.endsWith('1 other input was given too'); // true
 * ```
 */
export const RemotePageMixedWithOtherInputs: Failure.FailureFactory<
  'RemotePageMixedWithOtherInputs',
  { page: string; alongside: number }
> = Failure.define(
  'RemotePageMixedWithOtherInputs',
  (data: { page: string; alongside: number }) =>
    `${data.page} is a suite of its own and runs on its own — ${data.alongside} other ` +
    `${data.alongside === 1 ? 'input was' : 'inputs were'} given too`,
);

/**
 * Runs every remote QUnit page in the config, one after another, and reports as one run.
 *
 * Sequential on purpose: two pages reporting into one TAP stream at once interleave, and a page
 * nobody wrote is not a bundle that can be split — the parallelism a run has to offer is in the
 * pages themselves, which are already whole suites.
 *
 * ```ts
 * import type { runRemotePages } from './remote-pages.ts';
 * import type { Config } from '../../types.ts';
 * import type { Browser } from 'playwright-core';
 *
 * // Defined, not invoked: it drives a real browser.
 * async function example(run: typeof runRemotePages, config: Config, browser: Promise<Browser>) {
 *   return (await run(config, ['https://x/test/'], browser)).exitCode; // 0 when they all passed
 * }
 * ```
 */
export async function runRemotePages(
  config: Config,
  urls: string[],
  browserPromise: Promise<Browser>,
): Promise<RunOutcome> {
  const startedAt = Date.now();
  Reporter.runStart(config, { fileCount: urls.length, groupCount: urls.length });

  const browser = await browserPromise;
  let exitCode = 0;
  for (const url of urls) {
    const page = await browser.newPage();
    // The page's own console is the only window into a suite that fails to start, and `--debug`
    // is where the run already says it wants one.
    if (config.debug) {
      page.on('console', (message) => process.stdout.write(`# ${message.text()}\n`));
    }
    try {
      await runQUnitRemotePage(config, page, url);
    } catch (error) {
      Reporter.error(config, red(`${(error as Error)?.message ?? String(error)}`), {
        stream: 'both',
      });
      exitCode = 1;
    } finally {
      await page.close().catch(() => {});
    }
  }

  const finishedAt = Date.now();
  await Reporter.runEnd(config, { durationMs: finishedAt - startedAt });
  if (config.state.results.counter.failed > 0) exitCode = 1;

  // The daemon owns its browser across runs; a local run owns this one.
  if (!config.state.daemon) {
    await closeCompletely({
      browser: Task(browser.close()).ignore('browser.close'),
      prelaunch: shutdownPrelaunch(),
    });
  }

  return { exitCode, durationMs: finishedAt - startedAt, startedAt, finishedAt };
}
