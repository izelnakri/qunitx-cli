import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as Failure from '../result/failure.ts';
import * as Reporter from '../reporters/index.ts';
import { invalidOptionReason } from '../record/options.ts';
import type { Page } from 'playwright-core';
import type { Capture } from '../record/capture.ts';
import type { PdfOptions } from '../record/pdf.ts';
import type { SnapshotComparison } from '../record/index.ts';
import type { Config } from '../types.ts';

/**
 * How a run's snapshots are kept, compared and reviewed: `package.json#qunitx.snapshots`, the
 * `--snapshot-*` flags and the JS API's `snapshots` option all take this shape, the flags winning
 * setting by setting. Its rules are `qunitx record`'s: the same threshold, maxDiff, mask, report
 * and comment, applied to the snapshots tests take with `qunitxSnapshot()`.
 *
 * ```ts
 * const settings: SnapshotSettings = { dir: 'test/snapshots', threshold: 0.05, mask: ['#clock'], report: true };
 * ```
 */
export interface SnapshotSettings {
  /** Where baselines live, relative to the project root. Default `snapshots`. */
  dir?: string;
  /** Accept what changed: new screenshots replace their baselines. */
  update?: boolean;
  /** How far a pixel's color may move, 0–1, before it counts. Default 0.1. */
  threshold?: number;
  /** How many pixels may change before a snapshot counts as changed. Default 0. */
  maxDiff?: number;
  /**
   * CSS selectors of what changes on its own (clocks, avatars, ads): covered in every snapshot, so
   * comparing ignores it.
   */
  mask?: string[];
  /**
   * Also write the report into `dir`: changed snapshots first, side by side. `true` or `'html'`
   * is `report.html`, `'pdf'` is `report.pdf` (printed with `pdf`), `['html', 'pdf']` both.
   */
  report?: boolean | 'html' | 'pdf' | ('html' | 'pdf')[];
  /** How `report.pdf` is printed: the settings `qunitx record`'s `pdf` takes. */
  pdf?: PdfOptions;
  /** Also write `comment.md` into `dir`, a pull-request comment. Needs `imagesUrl`. */
  prComment?: boolean;
  /** The public URL `dir` is published at, which the comment's images link to. */
  imagesUrl?: string;
  /** Where the comment's "Download the full report" link points. */
  reportUrl?: string;
}

/**
 * What a test can pass to `qunitxSnapshot(name, options)`.
 *
 * ```ts
 * const options: SnapshotOptions = { selector: '#cart', mask: ['.price'], threshold: 0.2 };
 * ```
 */
export interface SnapshotOptions {
  /** Snapshot this element instead of the viewport. */
  selector?: string;
  /** The whole scrollable page instead of the viewport. */
  fullPage?: boolean;
  /** More selectors for comparing to ignore in this snapshot, on top of the run's `mask`. */
  mask?: string[];
  /** This snapshot's threshold, over the run's. */
  threshold?: number;
  /** This snapshot's maxDiff, over the run's. */
  maxDiff?: number;
}

/**
 * One snapshot a test took during the run.
 *
 * ```ts
 * const taken: SnapshotResult = {
 *   name: 'cart/empty',
 *   test: 'Cart > shows an empty cart',
 *   path: '/proj/snapshots/cart/empty.png',
 *   width: 1280,
 *   height: 720,
 *   comparison: { status: 'new', changedPixels: 0, totalPixels: 921_600, diffPath: null, currentPath: null },
 * };
 * ```
 */
export interface SnapshotResult {
  /** As the test named it. */
  name: string;
  /** `Module > test` that took it, or null outside a test. */
  test: string | null;
  /** The baseline's absolute path. */
  path: string;
  /** In device pixels. */
  width: number;
  /** In device pixels. */
  height: number;
  /** How it compared with the baseline. */
  comparison: SnapshotComparison;
}

/**
 * One step a test recorded with `qunitxRecording.start(name)` … `.stop()`.
 *
 * ```ts
 * const step: StepRecording = { name: 'checkout', test: 'Cart > checks out', path: '/proj/snapshots/checkout.gif', width: 1280, height: 720, frames: 14, bytes: 81_234 };
 * ```
 */
export interface StepRecording {
  /** As the test named it. */
  name: string;
  /** `Module > test` that recorded it, or null outside a test. */
  test: string | null;
  /** The GIF's absolute path. */
  path: string;
  /** In device pixels. */
  width: number;
  /** In device pixels. */
  height: number;
  /** Frames in the GIF. */
  frames: number;
  /** Its size on disk. */
  bytes: number;
}

// What a test page has during a qunitx run, for tests written in TypeScript: reference these
// types (`import type {} from 'qunitx-cli'`) and the optional calls type-check. Optional because
// the same test file can run where they are absent — opened from disk, or in another runner.
declare global {
  /** Takes a visual snapshot, compared with its baseline; see `SnapshotOptions`. */
  var qunitxSnapshot:
    | ((name: string, options?: SnapshotOptions) => Promise<SnapshotComparison & { path: string }>)
    | undefined;
  /** Records a step as a GIF: `start(name)`, then `stop()` for the file it wrote. */
  var qunitxRecording:
    { start(name: string): Promise<null>; stop(): Promise<StepRecording> } | undefined;
  /** During a step recording, makes sure the frame just drawn is in it. */
  var qunitxRecordFrame: (() => Promise<null | void>) | undefined;
}

/**
 * Where baselines go unless `snapshots.dir` says otherwise, relative to the project root.
 *
 * ```ts
 * import { DEFAULT_DIR } from './index.ts';
 *
 * DEFAULT_DIR; // 'snapshots'
 * ```
 */
export const DEFAULT_DIR = 'snapshots';

const SETTINGS = [
  'dir',
  'update',
  'threshold',
  'maxDiff',
  'mask',
  'report',
  'prComment',
  'imagesUrl',
  'reportUrl',
  'pdf',
] as const;
const OPTIONS = ['selector', 'fullPage', 'mask', 'threshold', 'maxDiff'] as const;
// How many frames a second a step recording keeps, and how long its last frame holds.
const RECORDING = { fps: 10, lastFrameDurationMs: 1000 } as const;
// An element that is not there fails the snapshot in a moment, not after Playwright's 30 s.
const ELEMENT_TIMEOUT_MS = 5000;

/**
 * A snapshot setting that will not do, from package.json, a flag or the JS API.
 *
 * ```ts
 * import { InvalidSnapshotSetting } from './index.ts';
 *
 * InvalidSnapshotSetting({ setting: 'threshold', reason: 'expected a fraction from 0 to 1, got 2' }).message;
 * // 'snapshots.threshold: expected a fraction from 0 to 1, got 2'
 * ```
 */
export const InvalidSnapshotSetting: Failure.FailureFactory<
  'InvalidSnapshotSetting',
  { setting: string | null; reason: string }
> = Failure.define(
  'InvalidSnapshotSetting',
  (data: { setting: string | null; reason: string }) =>
    `snapshots${data.setting ? `.${data.setting}` : ''}: ${data.reason}`,
);

/**
 * Checks snapshot settings by `qunitx record`'s rules and hands back the ones given, or the
 * first that will not do.
 *
 * ```ts
 * import { checkSettings } from './index.ts';
 *
 * checkSettings({ threshold: 0.2, mask: ['#clock'] }); // { threshold: 0.2, mask: ['#clock'] }
 * (checkSettings({ maxDiff: -1 }) as Error).message; // 'snapshots.maxDiff: expected a whole number from 0 to 9007199254740991, got -1'
 * ```
 */
export function checkSettings(
  raw: unknown,
): SnapshotSettings | Failure.Of<typeof InvalidSnapshotSetting> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return InvalidSnapshotSetting({ setting: null, reason: 'must be an object' });
  }
  const settings: Record<string, unknown> = {};
  for (const [setting, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (!(SETTINGS as readonly string[]).includes(setting)) {
      return InvalidSnapshotSetting({
        setting,
        reason: `is not a snapshot setting (${SETTINGS.join(', ')})`,
      });
    }
    // `dir` is a path like record's `output`; the rest share record's names and rules.
    const reason = invalidOptionReason(setting === 'dir' ? 'output' : setting, value);
    if (reason) return InvalidSnapshotSetting({ setting, reason });
    settings[setting] = value;
  }
  return settings as SnapshotSettings;
}

/**
 * The path, relative to the snapshot directory and without `.png`, that a snapshot `name` is kept
 * at: `/` makes folders, and anything a file name should not hold becomes `-`. Throws for a name
 * that is empty or climbs out (`..`).
 *
 * ```ts
 * import { fileNameOf } from './index.ts';
 *
 * fileNameOf('cart/empty state'); // 'cart/empty state'
 * fileNameOf('Checkout: step 1?'); // 'Checkout- step 1-'
 * ```
 */
export function fileNameOf(name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`a snapshot needs a name, got ${JSON.stringify(name) ?? String(name)}`);
  }
  const segments = name.split('/').map((segment) => segment.replace(/[^\w .-]/g, '-').trim());
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`"${name}" is not a usable snapshot name: no empty, "." or ".." parts`);
  }
  return segments.join('/');
}

/**
 * The absolute snapshot directory of a run.
 *
 * ```ts
 * import { directoryOf } from './index.ts';
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: needs a resolved Config.
 * function where(config: Config) {
 *   return directoryOf(config); // '/proj/snapshots'
 * }
 * ```
 */
export function directoryOf(config: Config): string {
  return path.resolve(config.projectRoot, config.snapshots?.dir ?? DEFAULT_DIR);
}

// The encoders, the diff and the screen capture load on a run's first snapshot, not with every
// run: most test runs take none.
const heavy = () =>
  Promise.all([
    import('../record/snapshot.ts'),
    import('../record/capture.ts'),
    import('../record/gif.ts'),
  ]).then(([Snapshot, Capture, GIF]) => ({ Snapshot, Capture, GIF }));

// Each page is wired once: exposeFunction cannot be repeated on a page, and the daemon reuses its
// page across runs, so what changes from run to run (the config) is read from here on every call.
const wired = new WeakMap<Page, PageState>();

interface PageState {
  config: Config;
  recording: { name: string; test: string | null; capture: Capture } | null;
}

// The globals a test calls. Both wait two animation frames first: WebKit screenshots the last
// frame it painted, and a style set a moment ago has not been painted yet.
const BROWSER_API = `(() => {
  const painted = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const currentTest = () => {
    const test = globalThis.QUnit && globalThis.QUnit.config && globalThis.QUnit.config.current;
    return test ? [test.module && test.module.name, test.testName].filter(Boolean).join(' > ') : null;
  };
  globalThis.qunitxSnapshot = (name, options) =>
    painted().then(() => globalThis.__qunitxSnapshot(name, options || {}, currentTest()));
  globalThis.qunitxRecording = {
    start: (name) => globalThis.__qunitxRecording('start', name, currentTest()),
    stop: () => painted().then(() => globalThis.__qunitxRecording('stop', null, currentTest())),
  };
  // \`qunitx record\` gives a script its own; this one only snaps a test's step recording.
  globalThis.qunitxRecordFrame ??= () =>
    painted().then(() => globalThis.__qunitxRecording('frame', null, null));
})();`;

/**
 * Gives a test page `qunitxSnapshot()` and `qunitxRecording`, answered in Node against `config`.
 * Safe to call again for the same page with a later run's config: the daemon does exactly that.
 *
 * ```ts
 * import { install } from './index.ts';
 * import type { Page } from 'playwright-core';
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: needs a live page.
 * async function wire(page: Page, config: Config) {
 *   await install(page, config);
 * }
 * ```
 */
export async function install(page: Page, config: Config): Promise<void> {
  const existing = wired.get(page);
  if (existing) {
    existing.config = config;
    return;
  }
  const state: PageState = { config, recording: null };
  wired.set(page, state);
  await page.exposeFunction(
    '__qunitxSnapshot',
    (name: unknown, options: unknown, test: string | null) =>
      take(page, state.config, name, options, test),
  );
  await page.exposeFunction(
    '__qunitxRecording',
    (action: 'start' | 'stop' | 'frame', name: unknown, test: string | null) =>
      record(page, state, action, name, test),
  );
  await page.addInitScript({ content: BROWSER_API });
}

async function take(
  page: Page,
  config: Config,
  name: unknown,
  rawOptions: unknown,
  test: string | null,
): Promise<SnapshotComparison & { path: string }> {
  const options = checkOptions(name, rawOptions);
  const settings = config.snapshots ?? {};
  const file = path.join(directoryOf(config), `${fileNameOf(name)}.png`);
  const { taken } = config.state.results.snapshots;
  const earlier = taken.find((snapshot) => snapshot.path === file);
  if (earlier) {
    throw new Error(
      `qunitxSnapshot("${name}") was already taken in this run, by ${earlier.test ?? 'code outside a test'}; ` +
        `snapshot names have to be unique (taken again by ${test ?? 'code outside a test'})`,
    );
  }
  // Claimed before the screenshot, so two tests racing for one name cannot both get it.
  const entry: SnapshotResult = {
    name: name as string,
    test,
    path: file,
    width: 0,
    height: 0,
    comparison: {
      status: 'new',
      changedPixels: 0,
      totalPixels: 0,
      diffPath: null,
      currentPath: null,
    },
  };
  taken.push(entry);
  try {
    const mask = [...(settings.mask ?? []), ...(options.mask ?? [])].map((selector) =>
      page.locator(selector),
    );
    const target = options.selector ? page.locator(options.selector).first() : page;
    const { Snapshot } = await heavy();
    const png = await target.screenshot({
      type: 'png',
      // A transition caught mid-way or a blinking caret is a difference nobody made.
      animations: 'disabled',
      caret: 'hide',
      timeout: ELEMENT_TIMEOUT_MS,
      ...(options.fullPage && !options.selector ? { fullPage: true } : {}),
      ...(mask.length ? { mask } : {}),
    });
    entry.width = readUint32(png, 16);
    entry.height = readUint32(png, 20);
    entry.comparison = await Snapshot.compare(file, png, {
      threshold: options.threshold ?? settings.threshold ?? 0.1,
      maxDiff: options.maxDiff ?? settings.maxDiff ?? 0,
      accept: settings.update ?? false,
    });
    return { ...entry.comparison, path: file };
  } catch (error) {
    taken.splice(taken.indexOf(entry), 1);
    throw error;
  }
}

async function record(
  page: Page,
  state: PageState,
  action: 'start' | 'stop' | 'frame',
  name: unknown,
  test: string | null,
): Promise<StepRecording | null> {
  const { recordings, open } = state.config.state.results.snapshots;
  if (action === 'frame') {
    if (state.recording) await state.recording.capture.snap();
    return null;
  }
  const { Snapshot, Capture, GIF } = await heavy();
  if (action === 'start') {
    const fileName = fileNameOf(name);
    if (state.recording) {
      throw new Error(
        `qunitxRecording.start("${name}"): "${state.recording.name}" is still recording; stop it first`,
      );
    }
    const file = path.join(directoryOf(state.config), `${fileName}.gif`);
    if (recordings.some((step) => step.path === file) || open.includes(file)) {
      throw new Error(
        `qunitxRecording.start("${name}"): recording names have to be unique in a run`,
      );
    }
    open.push(file);
    state.recording = { name: name as string, test, capture: Capture.start(page, RECORDING) };
    // Its first frame is the page as the recording started, whatever the test does next.
    await state.recording.capture.snap();
    return null;
  }
  const running = state.recording;
  if (!running) throw new Error('qunitxRecording.stop(): nothing is recording');
  state.recording = null;
  const shots = await running.capture.stop();
  const file = path.join(directoryOf(state.config), `${fileNameOf(running.name)}.gif`);
  open.splice(open.indexOf(file), 1);
  const { bytes, width, height, frames } = GIF.fromClips(
    [{ shots, lastFrameDurationMs: RECORDING.lastFrameDurationMs }],
    RECORDING.fps,
  );
  await Snapshot.write(file, bytes);
  const step = {
    name: running.name,
    test: running.test,
    path: file,
    width,
    height,
    frames,
    bytes: bytes.length,
  };
  recordings.push(step);
  return step;
}

// Validated where the test can see it: a bad option rejects the promise the test awaited.
function checkOptions(name: unknown, raw: unknown): SnapshotOptions {
  const fail = (reason: string) => new Error(`qunitxSnapshot(${JSON.stringify(name)}): ${reason}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw fail('options must be an object');
  for (const [option, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (!(OPTIONS as readonly string[]).includes(option)) {
      throw fail(`${option} is not an option (${OPTIONS.join(', ')})`);
    }
    const reason =
      option === 'selector'
        ? typeof value === 'string' && value !== ''
          ? null
          : `expected a CSS selector, got ${JSON.stringify(value)}`
        : invalidOptionReason(option, value);
    if (reason) throw fail(`${option}: ${reason}`);
  }
  return raw as SnapshotOptions;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

/**
 * Closes the run's snapshots: writes the report and comment asked for, prints each changed
 * snapshot with where to look and how to accept it, and says how many changed — a changed,
 * unaccepted snapshot fails the run, as a failed test does.
 *
 * ```ts
 * import { finish } from './index.ts';
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: needs a resolved Config whose run took snapshots.
 * async function close(config: Config) {
 *   return (await finish(config)) > 0; // true when the run has to fail for them
 * }
 * ```
 */
export async function finish(
  config: Config,
  print?: (reportPath: string) => Promise<Uint8Array>,
): Promise<number> {
  const results = config.state.results.snapshots;
  const directory = directoryOf(config);
  const shown = (file: string) => path.relative(config.projectRoot, file) || file;
  for (const file of results.open) {
    Reporter.warning(
      config,
      `qunitxRecording: ${shown(file)} was started but never stopped, so it was not written`,
    );
  }
  results.open.length = 0;
  if (results.taken.length === 0) return 0;

  const settings = config.snapshots ?? {};
  const { Snapshot } = await heavy();
  const reviews = await Snapshot.writeReviews(
    results.taken.map(({ path: file, width, height, comparison }) => ({
      path: file,
      width,
      height,
      comparison,
    })),
    {
      directory,
      report: settings.report,
      prComment: settings.prComment,
      imagesUrl: settings.imagesUrl,
      reportUrl: settings.reportUrl,
      print,
    },
  );
  results.reportPath = reviews.reportPath;
  results.reportPdfPath = reviews.reportPdfPath;
  results.commentPath = reviews.commentPath;
  const changed = results.taken.filter((snapshot) => snapshot.comparison.status === 'changed');
  for (const snapshot of changed) {
    const { changedPixels, totalPixels, diffPath, currentPath } = snapshot.comparison;
    const share = ((changedPixels / totalPixels) * 100).toFixed(2);
    const review = [diffPath, currentPath]
      .filter((file) => file !== null)
      .map((file) => shown(file));
    Reporter.warning(
      config,
      `snapshot "${snapshot.name}"${snapshot.test ? ` (${snapshot.test})` : ''} changed: ` +
        `${changedPixels.toLocaleString('en-US')} pixels (${share}%) → ${review.join(', ')}`,
    );
  }
  if (changed.length) {
    Reporter.warning(
      config,
      `${changed.length} snapshot${changed.length === 1 ? '' : 's'} changed: see the .diff.png beside each, then run again with --update-snapshots to accept`,
    );
  }
  if (reviews.reportPath) Reporter.info(config, `snapshot report: ${shown(reviews.reportPath)}`);
  if (reviews.reportPdfPath) {
    Reporter.info(config, `snapshot report: ${shown(reviews.reportPdfPath)}`);
  }
  if (reviews.commentPath) Reporter.info(config, `snapshot comment: ${shown(reviews.commentPath)}`);
  return changed.length;
}

/**
 * Whether the run's snapshots fail it: any changed and not accepted.
 *
 * ```ts
 * import { anyChanged } from './index.ts';
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: needs a resolved Config.
 * function red(config: Config) {
 *   return anyChanged(config);
 * }
 * ```
 */
export function anyChanged(config: Config): boolean {
  return config.state.results.snapshots.taken.some(
    (snapshot) => snapshot.comparison.status === 'changed',
  );
}

/**
 * How a run prints `report.pdf`: in a page `open` gives it, from the written `report.html`, with
 * `snapshots.pdf`, vector or raster as `config.browser` allows.
 *
 * ```ts
 * import { reportPrinter } from './index.ts';
 * import type { Browser } from 'playwright-core';
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: needs the run's browser.
 * function printer(browser: Browser, config: Config) {
 *   return reportPrinter(() => browser.newPage(), config);
 * }
 * ```
 */
export function reportPrinter(
  open: () => Promise<Page>,
  config: Config,
): (reportPath: string) => Promise<Uint8Array> {
  return async (reportPath) => {
    const PDF = await import('../record/pdf.ts');
    const settings = config.snapshots?.pdf ?? {};
    const mode = PDF.getMode(settings, config.browser ?? 'chromium');
    const page = await open();
    try {
      await page.goto(pathToFileURL(reportPath).href, { waitUntil: 'load' });
      const title = (await page.title().catch(() => '')) || 'Visual changes';
      const printed = await PDF.fromPage(page, settings, mode === 'vector' ? 'vector' : 'raster', {
        title,
        quality: 90,
      });
      return printed.bytes;
    } finally {
      await page.close().catch(() => {});
    }
  };
}
