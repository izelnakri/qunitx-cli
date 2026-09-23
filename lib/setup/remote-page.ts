import * as Reporter from '../reporters/index.ts';
import * as Failure from '../result/failure.ts';
import { isRemoteInput } from './remote-inputs.ts';
import type { Config } from '../types.ts';
import type { Page } from 'playwright-core';

// A QUnit page somebody else is serving, run where it stands.
//
// `qunitx https://objectmodel.js.org/test/` is a suite that already exists: the page loads its own
// QUnit, its own specs, and knows how to run them. There is nothing here to bundle and no module
// to import — the only thing missing is a way to watch it happen and say so in TAP.
//
// So this does not fetch the page's code. It opens the page in the browser the run already has,
// hooks QUnit before any of the page's scripts run, and reports what QUnit reports. The page is
// in charge; we are the reporter it never had.

/**
 * The page could not be driven — it never loaded, or QUnit never finished.
 *
 * ```ts
 * import { PageUnrunnable } from './remote-page.ts';
 *
 * PageUnrunnable({ url: 'https://x/test/', why: '404 Not Found' }).message;
 * // 'could not run https://x/test/ — 404 Not Found'
 * ```
 */
export const PageUnrunnable: Failure.FailureFactory<
  'PageUnrunnable',
  { url: string; why: string }
> = Failure.define(
  'PageUnrunnable',
  (data: { url: string; why: string }) => `could not run ${data.url} — ${data.why}`,
);

/** The one failure this module declares. */
export type PageUnrunnableFailure = Failure.Of<typeof PageUnrunnable>;

/**
 * What a QUnit page looks like from the outside.
 *
 * The markup every QUnit runner has had since 1.x: the fixture element its docs tell you to add,
 * the reporter's own container, or a script that is QUnit itself. Checked against the HTML rather
 * than against the URL, because `/test`, `/test/`, `/tests/index.html` and `/qunit.html` are all
 * the same page and none of them is a naming convention.
 *
 * ```ts
 * import { looksLikeQUnitPage } from './remote-page.ts';
 *
 * looksLikeQUnitPage('<div id="qunit-fixture"></div>'); // true
 * looksLikeQUnitPage('<script src="https://code.jquery.com/qunit/qunit-2.17.2.js"></script>'); // true
 * looksLikeQUnitPage('<a href="a-test.js">a-test.js</a>'); // false — a directory listing
 * ```
 */
export function looksLikeQUnitPage(html: string): boolean {
  return (
    /id=["']qunit(-fixture)?["']/i.test(html) ||
    /<script[^>]+src=["'][^"']*qunit[^"']*\.js/i.test(html) ||
    /\bQUnit\.(test|module|start|config)\b/.test(html)
  );
}

/**
 * Whether a URL answers with a QUnit page, remembered per process.
 *
 * Asked twice — once while the inputs are expanded, once when the run decides what to do with
 * them — and a suite's own page should not be fetched twice to answer the same question. The
 * answer is a property of the URL, so the memo is keyed by it.
 *
 * ```ts
 * import { isRemoteQUnitPage } from './remote-page.ts';
 *
 * // Defined, not invoked: it fetches the URL.
 * function example() {
 *   return isRemoteQUnitPage('https://objectmodel.js.org/test/'); // true
 * }
 * ```
 */
export async function isRemoteQUnitPage(url: string): Promise<boolean> {
  const held = KNOWN.get(url);
  if (held !== undefined) return held;
  // A URL that names a module is not asked about at all: it would cost every remote test file a
  // second fetch — one to wonder whether it is a page, one to bundle it.
  if (!couldBeAPage(url)) return false;

  // Fetched here rather than through `fetchRemote`, whose refusal of HTML is about modules and
  // says nothing about QUnit: reading that refusal as a yes made every website on the internet a
  // test suite. Unreachable is `false` — the walk that follows will say so in its own words.
  const verdict = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(LOOK_MS) })
    .then(async (response) => {
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || !type.toLowerCase().includes('html')) return false;

      return looksLikeQUnitPage(await response.text());
    })
    .catch(() => false);
  KNOWN.set(url, verdict);

  return verdict;
}

/** How long the look above is given. It is one GET of a page the run is about to open anyway. */
const LOOK_MS = 30_000;

/** One answer per URL per process — see {@link isRemoteQUnitPage}. */
const KNOWN = new Map<string, boolean>();

/**
 * Whether a URL could name a page at all: `.html`, or no extension.
 *
 * Cheap and syntactic, so the fetch below is only spent where the answer could be yes — a
 * `-test.js` is a module whatever it is served with, and asking a server twice about one is the
 * kind of waste that only shows up as a slow suite.
 *
 * ```ts
 * import { couldBeAPage } from './remote-page.ts';
 *
 * couldBeAPage('https://x/test/'); // true
 * couldBeAPage('https://x/test'); // true
 * couldBeAPage('https://x/tests/index.html'); // true
 * couldBeAPage('https://x/tests/cart-test.js'); // false — that is a module
 * ```
 */
export function couldBeAPage(url: string): boolean {
  const last = (url.split(/[?#]/)[0] ?? url).split('/').at(-1) ?? '';
  if (!last.includes('.')) return true;

  return /\.html?$/i.test(last);
}

/**
 * The inputs of a run that are pages somebody else serves, in the order they were given.
 *
 * Beside {@link isRemoteQUnitPage} rather than beside the run that calls it: this is the same
 * question asked of a whole config, and recognising a page is one subject that should live in one
 * place. What to DO about them — announce, drive, summarise — is the run's, in
 * `lib/commands/test/remote-pages.ts`.
 *
 * ```ts
 * import type { filterRemotePagesFromConfig } from './remote-page.ts';
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: it asks each remote input what it answers with.
 * async function example(find: typeof filterRemotePagesFromConfig, config: Config) {
 *   return await find(config); // ['https://objectmodel.js.org/test/']
 * }
 * ```
 */
export async function filterRemotePagesFromConfig(config: Config): Promise<string[]> {
  const inputs = Object.keys(config.fsTree).filter(isRemoteInput);
  const verdicts = await Promise.all(inputs.map(isRemoteQUnitPage));

  return inputs.filter((_input, at) => verdicts[at] === true);
}

/**
 * The URL to open, with the run's own filter applied as QUnit's.
 *
 * QUnit reads `filter` and `moduleId` off the query string, which is how its own HTML reporter
 * narrows a run — so `-t adds` becomes the page's `?filter=adds` and everything the URL already
 * carried is kept. A URL that names its own `filter` keeps it: it was typed, and this was not.
 *
 * ```ts
 * import { addQUnitFilter } from './remote-page.ts';
 *
 * addQUnitFilter('https://x/test/', 'adds'); // 'https://x/test/?filter=adds'
 * addQUnitFilter('https://x/test/?moduleId=6e15ed5f', 'adds');
 * // 'https://x/test/?moduleId=6e15ed5f&filter=adds'
 * addQUnitFilter('https://x/test/?filter=mine', 'adds'); // 'https://x/test/?filter=mine'
 * addQUnitFilter('https://x/test/', undefined); // 'https://x/test/'
 * ```
 */
export function addQUnitFilter(url: string, filter: string | undefined): string {
  if (filter === undefined || filter === '') return url;

  const parsed = new URL(url);
  if (parsed.searchParams.has('filter')) return url;
  parsed.searchParams.set('filter', filter);

  return parsed.href;
}

/**
 * The page-side hook, as one self-contained function.
 *
 * Handed to `addInitScript`, so — like `lib/setup/qunit-harness.ts` — it runs before any of the
 * page's own scripts and may reference nothing outside itself.
 *
 * It cannot simply call `QUnit.on(...)`: on a page we did not write, QUnit does not exist yet. So
 * `window.QUnit` is trapped, and the reporters are attached in the setter, the moment the page's
 * own `<script src="qunit.js">` assigns it.
 *
 * What crosses back is trimmed hard. A `testEnd` carries every assertion, and an assertion carries
 * `actual` and `expected` — whole object graphs on a page like ObjectModel's. Sending them
 * unabridged through one binding call per test took 60 seconds to deliver 33 of 90 tests; trimmed,
 * the same suite arrives complete in 649ms.
 *
 * ```ts
 * import { trapQUnitHooks } from './remote-page.ts';
 *
 * // Defined, not invoked: it runs in the page, before the page's own scripts.
 * function example() {
 *   return trapQUnitHooks.length; // 0 — it takes nothing, so `addInitScript` can hand it straight over
 * }
 * ```
 */
export function trapQUnitHooks(): void {
  const send = (event: string, details: unknown) => {
    (globalThis as unknown as Record<string, (payload: string) => void>).__qunitxPageEvent?.(
      JSON.stringify({ event, details }),
    );
  };

  let held: unknown;
  // The first assignment that is really QUnit wins, and every later one is only stored.
  //
  // `window.QUnit` is written more than once on a page that imports QUnit and then re-exports it
  // — two different objects sharing one emitter, so registering on both reports every test twice
  // and a green suite comes out with double the tests. It is also written BEFORE QUnit loads by
  // the documented preconfig pattern (`window.QUnit = { config: { … } }`), which has no `on` and
  // is skipped by the check below rather than mistaken for the real thing.
  let attached = false;
  Object.defineProperty(globalThis, 'QUnit', {
    configurable: true,
    get: () => held,
    set(value: unknown) {
      held = value;
      const qunit = value as {
        on?: (event: string, callback: (details: Record<string, unknown>) => void) => void;
      };
      if (typeof qunit.on !== 'function' || attached) return;
      attached = true;

      qunit.on('testEnd', (details) => {
        const errors = (details.errors ?? []) as Array<Record<string, unknown>>;

        send('testEnd', {
          name: details.name,
          fullName: details.fullName,
          status: details.status,
          runtime: details.runtime,
          // Only what a failure is read for: the message and where it happened. `actual` and
          // `expected` are whatever the page's objects are, and that is what made this slow.
          assertions: errors.map((error) => ({
            passed: false,
            todo: details.status === 'todo',
            message: typeof error.message === 'string' ? error.message : undefined,
            stack: typeof error.stack === 'string' ? error.stack : undefined,
          })),
        });
      });
      qunit.on('runEnd', (details) =>
        send('runEnd', { testCounts: details.testCounts, runtime: details.runtime }),
      );
    },
  });
}

/**
 * Opens one remote QUnit page and reports what it does, test by test.
 *
 * Resolves when QUnit says the run ended. Rejects with {@link PageUnrunnable} when the page will
 * not load, when nothing on it is QUnit, or when it stops saying anything for `config.timeout` —
 * a page that hangs halfway is the case a plain `waitForEvent` would sit through forever.
 *
 * ```ts
 * import type { runQUnitRemotePage } from './remote-page.ts';
 * import type { Config } from '../types.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: it drives a real browser page.
 * async function example(run: typeof runQUnitRemotePage, config: Config, page: Page) {
 *   await run(config, page, 'https://objectmodel.js.org/test/'); // reports as it goes
 * }
 * ```
 */
export async function runQUnitRemotePage(config: Config, page: Page, url: string): Promise<void> {
  const target = addQUnitFilter(url, config.filter);
  let lastHeard = Date.now();
  let finished: { testCounts?: Record<string, number>; runtime?: number } | null = null;

  await page.exposeFunction('__qunitxPageEvent', (payload: string) => {
    lastHeard = Date.now();
    const { event, details } = JSON.parse(payload) as { event: string; details: never };
    if (event === 'testEnd') Reporter.testEnd(config, details);
    else if (event === 'runEnd') finished = details;
  });
  await page.addInitScript(trapQUnitHooks);

  const response = await page.goto(target, { waitUntil: 'commit' }).catch((error: unknown) => {
    throw PageUnrunnable({ url: target, why: (error as Error)?.message ?? String(error) });
  });
  if (response !== null && !response.ok()) {
    throw PageUnrunnable({ url: target, why: `${response.status()} ${response.statusText()}` });
  }

  // Polled rather than awaited on one long promise: the deadline has to move with the last thing
  // heard, so a suite of a thousand tests is not killed for taking longer than one test's timeout.
  for (;;) {
    if (finished !== null) break;
    if (Date.now() - lastHeard > config.timeout) {
      throw PageUnrunnable({
        url: target,
        why: `nothing happened for ${Math.round(config.timeout / 1000)}s — is QUnit running there?`,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** How often the wait above looks, which is also the worst case it adds to a finished run. */
const POLL_MS = 25;
