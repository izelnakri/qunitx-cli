import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as Browser from '../setup/browser.ts';
import { findProjectRoot } from '../utils/find-project-root.ts';
import { isRemoteInput } from '../setup/remote-inputs.ts';
import { DEFAULT_FPS, type Settings } from './options.ts';
import type { Page } from 'playwright-core';

/**
 * The function a recorded script can call to put the screen as it is now into the recording:
 * `await globalThis.qunitxRecordFrame?.()`. Absent outside `qunitx record`, hence the `?.`.
 *
 * ```ts
 * import { FRAME_FUNCTION } from './capture.ts';
 *
 * FRAME_FUNCTION; // 'qunitxRecordFrame'
 * ```
 */
export const FRAME_FUNCTION = 'qunitxRecordFrame';

/**
 * One captured screen: a PNG, and when it was on screen relative to the capture's start.
 *
 * ```ts
 * const shot: Shot = { png: new Uint8Array(0), atMs: 0 };
 * shot.atMs; // 0 — the first frame of a capture
 * ```
 */
export interface Shot {
  /** The screen, losslessly. */
  png: Uint8Array;
  /** Milliseconds since the capture's first frame. */
  atMs: number;
  /** Taken because the script asked for it with `qunitxRecordFrame()`; never thinned away. */
  requested?: boolean;
}

/**
 * What one input looked like, for the GIFs it is part of: its shots, and how long the last one
 * stays on screen. Stills are shot from the page itself, not from here.
 *
 * ```ts
 * const clip: Clip = { shots: [], lastFrameDurationMs: 1000 };
 * clip.shots.length; // 0 — no GIF was asked for
 * ```
 */
export interface Clip {
  /** Empty when no GIF was asked for. */
  shots: Shot[];
  /** How long the last frame stays on screen in a GIF. */
  lastFrameDurationMs: number;
}

/**
 * A capture in progress. {@link Capture.stop} ends it and hands back every frame, in order.
 *
 * ```ts
 * const idle: Capture = { snap: () => Promise.resolve(), stop: () => Promise.resolve([]) };
 * ```
 */
export interface Capture {
  /** Takes a frame now, between the timed ones, and resolves once it is taken. */
  snap(): Promise<void>;
  /** Ends the capture, with one last frame of the screen as it is now. */
  stop(): Promise<Shot[]>;
}

/**
 * Starts recording what `page` shows: screenshots back to back, at most `fps` a second
 * ({@link DEFAULT_FPS} unless told). Each takes
 * 50–100ms in Chromium at common sizes, so expect 10–17 frames a second at best.
 *
 * Screenshots on every engine rather than Chromium's CDP screencast, because a screencast frame is
 * the whole browser window: it ignores the emulated viewport, so its size is whatever the window
 * happens to be. A screenshot is always the viewport, at the device scale asked for.
 *
 * Every frame is a PNG, lossless, because a GIF is quantized from it afterwards and a JPEG's
 * artifacts would cost palette entries for colors the page never had.
 *
 * ```ts
 * import { start } from './capture.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live page.
 * async function twoSeconds(page: Page) {
 *   const capture = start(page); // or start(page, { fps: 5 })
 *   await page.waitForTimeout(2000);
 *   return capture.stop(); // Shot[]
 * }
 * ```
 */
export function start(page: Page, { fps = DEFAULT_FPS }: { fps?: number } = {}): Capture {
  const shots: Shot[] = [];
  const startedAt = Date.now();
  const controller = new AbortController();
  // Every screenshot, timed or asked for, joins one queue, so shots stay in the order they were
  // taken and never overlap.
  let queue = Promise.resolve();
  const shoot = (requested = false) =>
    (queue = queue.then(async () => {
      const atMs = Date.now() - startedAt;
      const png = await page.screenshot({ type: 'png' }).catch(() => null);
      if (png) shots.push(requested ? { png, atMs, requested } : { png, atMs });
    }));
  // A shot, then a wait for the rest of its interval: a wait that stop() cuts short.
  const timed = (async () => {
    for (let takenAt = Date.now(); !controller.signal.aborted; takenAt = Date.now()) {
      await shoot();
      const rest = 1000 / fps - (Date.now() - takenAt);
      if (rest > 0) await delay(rest, undefined, { signal: controller.signal }).catch(() => {});
    }
  })();

  return {
    snap: () => shoot(true),
    async stop() {
      controller.abort();
      await timed;
      // The screen as it is now: the frame a recording ends on, and the one it holds.
      await shoot();
      return shots;
    },
  };
}

/**
 * Takes a frame of `capture` now, between the timed ones: `capture.snap()`, called as a function.
 *
 * ```ts
 * import * as Capture from './capture.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live page.
 * async function afterStep(page: Page) {
 *   const capture = Capture.start(page);
 *   await Capture.snap(capture);
 *   return Capture.stop(capture);
 * }
 * ```
 */
export function snap(capture: Capture): Promise<void> {
  return capture.snap();
}

/**
 * Ends `capture`, with one last frame of the screen as it is now, and hands back every frame, in
 * order: `capture.stop()`, called as a function.
 *
 * ```ts
 * import * as Capture from './capture.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live page.
 * async function oneSecond(page: Page) {
 *   const capture = Capture.start(page);
 *   await page.waitForTimeout(1000);
 *   return Capture.stop(capture); // Shot[]
 * }
 * ```
 */
export function stop(capture: Capture): Promise<Shot[]> {
  return capture.stop();
}

/**
 * The shots a recording at `fps` keeps: each at least `1000 / fps` ms after the last one kept, so a
 * capture faster than that does not crowd an animation with frames. Two are always kept: the last,
 * the frame a recording ends on and holds, and any a script asked for with `qunitxRecordFrame()`.
 *
 * ```ts
 * import * as Capture from './capture.ts';
 *
 * const shots = [0, 50, 100, 150, 160].map((atMs) => ({ png: new Uint8Array(0), atMs }));
 * Capture.limitFrameRate(shots, 10).map((shot) => shot.atMs); // [0, 100, 160]
 * ```
 */
export function limitFrameRate(shots: Shot[], fps: number): Shot[] {
  const minGapMs = 1000 / fps;
  return shots.reduce<Shot[]>((kept, shot, index) => {
    const previous = kept.at(-1);
    const isLast = index === shots.length - 1;
    if (!previous || shot.requested || isLast || shot.atMs - previous.atMs >= minGapMs) {
      kept.push(shot);
    }
    return kept;
  }, []);
}

/**
 * Records what `page` shows of `target`: a page at a URL once it has loaded and settled, or a
 * script while it runs. Its shots are taken only when `needsFrames`; a script's exit code comes
 * back with them (a page's is 0).
 *
 * ```ts
 * import * as Capture from './capture.ts';
 * import type { Settings } from './options.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live page.
 * async function recordHome(page: Page, settings: Settings) {
 *   const { clip } = await Capture.record(page, { url: 'https://example.com' }, settings, true, '.');
 *   return clip.shots.length; // 1: a page without pageDuration is one still
 * }
 * ```
 */
export async function record(
  page: Page,
  target: { url: string } | { script: string },
  settings: Settings,
  needsFrames: boolean,
  cwd: string,
): Promise<{ clip: Clip; exitCode: number }> {
  return 'script' in target
    ? recordScript(page, target.script, settings, needsFrames, cwd)
    : { clip: await recordWebPage(page, target.url, settings, needsFrames), exitCode: 0 };
}

async function recordWebPage(
  page: Page,
  url: string,
  settings: Settings,
  needsFrames: boolean,
): Promise<Clip> {
  // Reaching the page is bounded; loading it is the page's own business, bounded by --timeout
  // alone, as a script's run is: a slow page on a loaded machine is not a broken one.
  await page.goto(url, { waitUntil: 'commit', timeout: Browser.NAVIGATION_TIMEOUT_MS });
  await page.waitForLoadState('load', { timeout: settings.timeout ?? 0 });
  await settled(page, settings);
  if (!needsFrames) return { shots: [], lastFrameDurationMs: settings.lastFrameDuration };

  if (settings.pageDuration) {
    const capture = start(page, settings);
    await page.waitForTimeout(settings.pageDuration);
    return { shots: await capture.stop(), lastFrameDurationMs: settings.lastFrameDuration };
  }
  return {
    shots: [{ png: await page.screenshot({ type: 'png' }), atMs: 0 }],
    lastFrameDurationMs: settings.lastFrameDuration,
  };
}

async function recordScript(
  page: Page,
  script: string,
  settings: Settings,
  needsFrames: boolean,
  cwd: string,
): Promise<{ clip: Clip; exitCode: number }> {
  // A script is worth recording without a project around it, which `qunitx run` insists on: its
  // own directory stands in, for the paths its stack traces print relative to.
  const scriptDir = isRemoteInput(script) ? cwd : path.dirname(script);
  const projectRoot = await findProjectRoot(scriptDir).catch(() => scriptDir);
  // Started once the page navigates, not before: bundling comes first, and a recording that opens
  // on a second of blank page is a recording of the bundler.
  const capture: { started: Capture | null } = { started: null };
  if (needsFrames) {
    // Whichever comes first starts the capture: Playwright can deliver the script's first
    // qunitxRecordFrame() call before it delivers the navigation that preceded it.
    const begin = () => (capture.started ??= start(page, settings));
    page.once('framenavigated', begin);
    // Frames are sampled, so a step shorter than a screenshot can fall between two. A script that
    // must show a step calls this after drawing it; `?.()` keeps it runnable under `qunitx run`.
    // It waits for two animation frames first: WebKit screenshots the last frame it painted, and a
    // style set a moment ago has not been painted yet.
    await page.exposeFunction(`__${FRAME_FUNCTION}`, () => begin().snap());
    await page.addInitScript(
      `globalThis.${FRAME_FUNCTION} = () => new Promise((painted) => requestAnimationFrame(() => requestAnimationFrame(painted))).then(() => globalThis.__${FRAME_FUNCTION}());`,
    );
  }
  // Loaded here, not at the top: it is `qunitx run`'s whole module graph, and only a script needs it.
  const RunCommand = await import('../commands/run.ts');
  const outcome = await RunCommand.run(script, {
    page,
    cwd,
    projectRoot,
    browser: settings.browser,
    port: settings.port,
    timeout: settings.timeout,
    console: settings.console,
  });
  await settled(page, settings);
  return {
    // The capture has been taking frames since the page navigated; this ends it.
    clip: {
      shots: (await capture.started?.stop()) ?? [],
      lastFrameDurationMs: settings.lastFrameDuration,
    },
    exitCode: outcome.exitCode,
  };
}

// Waits until the page is what its stills should show: its web fonts loaded (they often finish
// after `load`, and a still taken before shows the fallback face), then `waitFor`.
async function settled(page: Page, settings: Settings): Promise<void> {
  await page.evaluate('document.fonts && document.fonts.ready.then(() => {})').catch(() => {});
  if (typeof settings.waitFor === 'number') await page.waitForTimeout(settings.waitFor);
  else if (settings.waitFor) {
    await page.waitForSelector(settings.waitFor, {
      state: 'attached',
      timeout: settings.timeout ?? 0,
    });
  }
}
