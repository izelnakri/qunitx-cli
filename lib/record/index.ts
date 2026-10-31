/**
 * `qunitx record`: screenshots and GIFs of pages, URLs and scripts, taken in a real browser.
 *
 * @module
 */
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import * as Browser from '../setup/browser.ts';
import * as Capture from './capture.ts';
import * as Diff from './diff.ts';

import * as Tour from './tour/index.ts';
import * as Deck from './deck.ts';
import * as Slides from './slides.ts';
import { DEFAULT_PANEL_HEIGHT, type Panel } from './panel.ts';
import { DEFAULT_PLAYER, type PlayerSettings } from './player.ts';
import { checkStyle, type ComposedFrame, type Style } from './tour/compose.ts';
import * as GIF from './gif.ts';
import * as Video from './video.ts';
import * as Inputs from './inputs.ts';
import * as JPEG from './jpeg.ts';
import * as Outputs from './outputs.ts';
import * as Options from './options.ts';
import type { Settings } from './options.ts';
import * as PDF from './pdf.ts';
import type { PdfOptions } from './pdf.ts';
import * as PNG from './png.ts';
import * as Report from './report.ts';

import { enterPhase } from './progress.ts';
import { Stream } from '../stream/index.ts';
import { HTTPServer, MIME_TYPES } from '../web/index.ts';
import * as Failure from '../result/failure.ts';
import { bindServerToPort } from '../setup/bind-server-to-port.ts';
import { closeCompletely } from '../utils/close-with-grace.ts';
import { withLoopAlive } from '../utils/with-loop-alive.ts';
import { shutdownPrelaunch } from '../chrome/prelaunch.ts';
import type { ConsoleOption } from '../console.ts';
import type { Browser as PlaywrightBrowser, BrowserContext, Page } from 'playwright-core';

export { FRAME_FUNCTION } from './capture.ts';
export { UnrecordableInput } from './inputs.ts';
export { DEFAULT_SIZE, InvalidRecordOption } from './options.ts';
export { UnknownFormat, type Format } from './outputs.ts';

/**
 * `compare` was asked of something other than a png still. A jpg's compression shifts pixels every
 * time it is saved, and an animation has no single frame to hold against a baseline.
 *
 * ```ts
 * import { CompareNeedsPng } from './index.ts';
 *
 * CompareNeedsPng({ path: '/shots/home.jpg' }).message.includes('-f png'); // true
 * ```
 */
export const CompareNeedsPng: Failure.FailureFactory<'CompareNeedsPng', { path: string }> =
  Failure.define(
    'CompareNeedsPng',
    (data: { path: string }) =>
      `--compare works on png stills, and ${path.basename(data.path)} is not one: a jpg's compression changes pixels on every save, and an animation has no single frame to compare. Use -f png.`,
  );

// What a page of a heavy site can take while it renders: what bounds pages recorded at once.
const MEMORY_PER_PAGE = 512 * 1024 ** 2;

/**
 * How to record. Every field is optional.
 *
 * ```ts
 * const options: RecordOptions = { formats: ['home.png'], width: 1200, height: 1200 };
 * options.formats; // ['home.png'] — a still of the one input, under that name
 * ```
 */
export interface RecordOptions {
  /** Directory relative inputs resolve against. Defaults to the process's. */
  cwd?: string;
  /** Directory the files are written to; relative to `cwd`. Defaults to `cwd`. */
  output?: string;
  /**
   * What to write: formats (`png`, `jpg`, `gif`, `webm`, `mp4`) and file names ending in one (`home.gif`). By
   * default a single page is a `.jpg`, and two or more inputs, or a script, add one `.gif`.
   */
  formats?: string[];
  /** Viewport width in CSS pixels. Defaults to 1280. */
  width?: number;
  /** Viewport height in CSS pixels. Defaults to 720. */
  height?: number;
  /** Device pixels per CSS pixel: `2` records at retina resolution. Defaults to 1. */
  scale?: number;
  /** Browser engine. Defaults to chromium. */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** Stills capture the whole scrollable page instead of the viewport. GIF frames never do. */
  fullPage?: boolean;
  /**
   * Waited for after a page loads, before anything is captured: milliseconds, or a CSS selector
   * that has to be on the page.
   */
  waitFor?: number | string;
  /**
   * How long each page is recorded for in a GIF, in ms. Unset, a page is one frame, shown for
   * `lastFrameDuration`. Scripts are recorded for as long as they run.
   */
  pageDuration?: number;
  /**
   * How long each input's last frame stays on screen in a GIF, in ms: a page's one still, or
   * the end of its recorded motion or of a script. Defaults to 1000.
   */
  lastFrameDuration?: number;
  /** The most frames per second a GIF keeps. Defaults to 10. */
  fps?: number;
  /** JPEG quality, 0–100. Defaults to 90. */
  quality?: number;
  /** Ms a script may run before it is declared hung. Unbounded by default, like `qunitx run`. */
  timeout?: number | null;
  /** First port tried for the local servers scripts and HTML files are loaded from. */
  port?: number;
  /**
   * Where a script's own console output, and nothing else, goes: the process's by default,
   * `false` for nowhere.
   */
  console?: ConsoleOption;
  /**
   * Treat each png already at an output path as the baseline: compare against it instead of
   * overwriting it, and write `<name>.diff.png` and `<name>.new.png` beside it when it changed.
   * Animations are frozen and the caret hidden for every still, so a page renders the same twice.
   */
  compare?: boolean;
  /** With `compare`, accept what changed: the new screenshot replaces the baseline. */
  update?: boolean;
  /** How far a pixel's color may move, as a fraction of black-to-white, before it counts. Default 0.1. */
  threshold?: number;
  /** How many pixels may change before a snapshot counts as changed. Default 0. */
  maxDiff?: number;
  /**
   * CSS selectors of what changes on its own (clocks, avatars, ads): covered in every still, so
   * comparing ignores it.
   */
  mask?: string[];
  /**
   * Write the report into the output directory: every snapshot, the changed ones first with
   * their diff and a wipe from baseline to new. `true` or `'html'` is `report.html`; `'pdf'` is
   * `report.pdf`, printed with the `pdf` settings; `['html', 'pdf']` both. Implies `compare`.
   */
  report?: boolean | 'html' | 'pdf' | ('html' | 'pdf')[];
  /**
   * Write `comment.md` into the output directory: a pull-request comment with each changed
   * snapshot's diff (before and after side by side), or "No visual changes" when there are none.
   * Needs `imagesUrl`. Implies `compare`.
   */
  prComment?: boolean;
  /**
   * The public URL the output directory is published at, by the workflow that posts the comment:
   * the comment's images are linked under it, since a comment cannot carry images of its own.
   */
  imagesUrl?: string;
  /** Where the comment's "Download the full report" link points, such as the CI run's artifacts. */
  reportUrl?: string;

  /**
   * A band above the frame or below the page with each step's title, its caption (a tour's, with
   * `caption: { placement: 'panel' }`) and where it is among the steps: drawn into a GIF, and the
   * HTML player's own. `height` in CSS pixels (96 by default), `style` CSS for `#panel`.
   */
  panel?: { placement?: 'above' | 'below'; height?: number; style?: Style };
  /**
   * A stylesheet over everything drawn around and over the pages: the panel, the player, slides,
   * and every tour's frame (under a tour's own `css`). Its selectors are in the README.
   */
  css?: string;
  /** The CSS background behind parts smaller than the biggest, and around the player. */
  backdrop?: string;
  /** Markdown and image slides: CSS declarations for each `.slide`. */
  slide?: { style?: Style };
  /** The HTML player (`-f demo.html`): how it advances, loops and starts, and where its pictures go. */
  player?: Partial<PlayerSettings>;
  /** How `pdf` outputs are made: paper, margins, header and footer, vector or raster. */
  pdf?: PdfOptions;
}

/**
 * How a still compared with its baseline under `compare`.
 *
 * - `new`: there was no baseline; this screenshot is now it.
 * - `unchanged`: within `threshold` and `maxDiff`; the baseline is left as it was.
 * - `changed`: the baseline is kept, and `diffPath` and `currentPath` show what changed.
 * - `updated`: it changed, and `update` made the new screenshot the baseline.
 *
 * ```ts
 * const comparison: SnapshotComparison = { status: 'unchanged', changedPixels: 0, totalPixels: 921_600, diffPath: null, currentPath: null };
 * ```
 */
export interface SnapshotComparison {
  /** What happened to the baseline; see above. */
  status: 'new' | 'unchanged' | 'changed' | 'updated';
  /** Pixels that moved past the threshold, anti-aliasing aside; every pixel when the size changed. */
  changedPixels: number;
  /** Pixels in the screenshot. */
  totalPixels: number;
  /** Before and after side by side, what changed boxed on both, when it changed and was not accepted. */
  diffPath: string | null;
  /** The new screenshot, written beside the baseline when it changed and was not accepted. */
  currentPath: string | null;
}

/**
 * One file `record` wrote.
 *
 * ```ts
 * const file: RecordedFile = { path: '/shots/home.jpg', format: 'jpeg', width: 1280, height: 720, bytes: 81_234, frames: 1 };
 * file.frames; // 1 — a still
 * ```
 */
export interface RecordedFile {
  /** Absolute. */
  path: string;
  /** What it was written as. */
  format: Outputs.Format;
  /** In device pixels: the viewport times `scale`, or the whole page for a full-page still. */
  width: number;
  /** In device pixels, like `width`. */
  height: number;
  /** Its size on disk. */
  bytes: number;
  /** Frames in the file: 1 for a still; for a PDF, its pages. */
  frames: number;
  /** How it compared with its baseline, under `compare`. */
  comparison?: SnapshotComparison;
}

/**
 * What a recording produced.
 *
 * ```ts
 * const result: RecordResult = { ok: true, files: [], failedScripts: [], changedSnapshots: [], reportPath: null, reportPdfPath: null, commentPath: null };
 * result.ok; // true
 * ```
 */
export interface RecordResult {
  /** False when a script exited non-zero, or a snapshot changed under `compare`. */
  ok: boolean;
  /** Every file written, in the order `formats` asked for them. */
  files: RecordedFile[];
  /** Each script that exited non-zero, with its exit code. */
  failedScripts: { path: string; exitCode: number }[];
  /** Baselines that changed and were not accepted, under `compare`. */
  changedSnapshots: string[];
  /** Where `report` wrote the review page, or null without it. */
  reportPath: string | null;
  /** `report.pdf`, when the report was asked for as a PDF. */
  reportPdfPath: string | null;
  /** Where `prComment` wrote the pull-request comment, or null without it. */
  commentPath: string | null;
}

// An input recorded: the page its stills are shot from, and what its GIF frames are. A tour's
// frames are drawn by `draw`, after its stills are taken.
interface Recorded {
  page: Page;
  clip: Capture.Clip;
  exitCode: number;
  stillScale?: 'css' | 'device';
  draw?: () => Promise<ComposedFrame[]>;
  /** In a recording of steps: the input's steps, instead of a clip. */
  part?: Deck.Part;
}

// The local server of each directory an HTML input is in, started the first time it is needed.
type Servers = Map<string, Promise<{ server: HTTPServer; origin: string }>>;

/**
 * Records each input — a URL, an `.html` file or a directory serving one, or a script that draws
 * while it runs — and writes the files `options.formats` asks for.
 *
 * Every input shares one browser and one viewport. A page is captured once it has loaded and
 * `waitFor` has passed; a script is recorded from the moment its page opens until its top level
 * settles, and its stills show where it ended up.
 *
 * ```ts
 * import { record } from './index.ts';
 *
 * // Defined, not invoked: launches a browser and writes files.
 * async function shoot() {
 *   const result = await record(['https://example.com'], { formats: ['home.png'], width: 1200 });
 *   return result.files.map((file) => file.path); // ['…/home.png']
 * }
 * ```
 */
export function record(sources: string[], options: RecordOptions = {}): Promise<RecordResult> {
  // Held open for the whole recording: the pre-launched Chrome and its pipe are unref'd, so a
  // browser that is slow to come up, or goes away, would otherwise leave nothing to wait on and
  // the process would end without a word.
  return withLoopAlive(() => recordAll(sources, options));
}

async function recordAll(sources: string[], options: RecordOptions): Promise<RecordResult> {
  if (!sources.length) {
    throw Inputs.UnrecordableInput({
      input: 'nothing',
      reason: 'give it a URL, page or script, or list them in package.json#qunitx.record',
    });
  }
  // The JS API's options are held to the command line's rules: an fps of 0 is a mistake to name,
  // not a division to attempt.
  Options.validate(options);
  enterPhase('reading the inputs');
  const cwd = options.cwd ?? process.cwd();
  const settings = Options.from(options);
  const inputs = await Inputs.resolve(sources, cwd);
  const directory = path.resolve(cwd, options.output ?? '.');
  const formats = options.formats ?? (settings.compare ? ['png'] : []);
  const planned = Outputs.plan(formats, inputs, directory);
  if (Outputs.UnknownFormat.is(planned)) throw planned;
  // Steps, a canvas and a panel: when anything but pages and scripts is recorded, or asked for.
  const deck =
    inputs.some((input) => !['url', 'html', 'script'].includes(input.kind)) ||
    planned.some((output) => output.format === 'html') ||
    options.panel !== undefined;
  // A recording of steps prints as one PDF of them all, so its pdf is planned as one output.
  const outputs = deck
    ? (Outputs.plan(formats, inputs, directory, true) as Outputs.Output[])
    : planned;
  const notPng = outputs.find((output) => output.format !== 'png');
  if (settings.compare && notPng) throw CompareNeedsPng({ path: notPng.absolutePath });
  // Whether this engine can print as asked is known now, before anything is recorded.
  const pdfMode =
    outputs.some((output) => output.format === 'pdf') || settings.report.includes('pdf')
      ? PDF.getMode(options.pdf ?? {}, settings.browser)
      : 'raster';
  if (PDF.UnprintablePdf.is(pdfMode)) {
    throw Options.InvalidRecordOption({ option: 'pdf', reason: pdfMode.data.reason });
  }
  // Made before the browser launches: a directory that cannot be written to fails now, not after
  // every input has been recorded.
  await Promise.all(
    [...new Set([directory, ...outputs.map((output) => path.dirname(output.absolutePath))])].map(
      (made) => mkdir(made, { recursive: true }),
    ),
  );

  const needsFrames = outputs.some((output) => output.inputIndex === null);
  enterPhase(`launching ${settings.browser}`);
  const browser = await Browser.launch({ browser: settings.browser });
  const servers: Servers = new Map();
  const context = await browser.newContext({
    viewport: { width: settings.width, height: settings.height },
    deviceScaleFactor: settings.scale,
  });
  const tourContexts: BrowserContext[] = [];
  try {
    // Frames are sampled on a clock, so a capture shares the CPU with no other page or it drops
    // them, and two scripts' console output would interleave; a tour is timed too. Stills and
    // PDFs of pages need neither, so those pages are recorded side by side.
    const maxConcurrency =
      needsFrames || inputs.some((input) => input.kind === 'script' || input.kind === 'tour')
        ? 1
        : maxParallelPageProcessingAtOnce();
    const look = deck ? await deckLook(context, options) : null;
    const prepare = (opened: Page) =>
      settings.browser === 'chromium' ? enlargeChromeWindow(opened, settings) : Promise.resolve();
    const shotsPart = (shots: Parameters<typeof Deck.shotsPart>[1], steps: Deck.Part['steps']) =>
      Deck.shotsPart(browser, shots, steps, {
        viewport: { width: settings.width, height: settings.height },
        scale: settings.scale,
        fps: settings.fps,
        prepare,
      });
    // What `input` showed on `page`: in a recording of steps, a part; otherwise a clip of the GIF.
    const recordInput = async (page: Page, input: Inputs.Input): Promise<Recorded> => {
      if (input.kind === 'tour') {
        return recordTour(input, browser, settings, needsFrames, deck, prepare, tourContexts);
      } else if (input.kind === 'slides' || input.kind === 'image') {
        const shown = await recordSlides(
          page,
          input,
          look!,
          { ...settings, css: options.css },
          (root, file) => serve(servers, { root, path: file }, settings),
        );
        return {
          page,
          clip: { shots: [], lastFrameDurationMs: settings.lastFrameDuration },
          exitCode: 0,
          part: { ...shotsPart(shown.shots, shown.steps), sheets: shown.sheets },
        };
      } else if (input.kind === 'script') {
        const { clip, exitCode } = await Capture.record(
          page,
          { script: input.path },
          settings,
          needsFrames,
          cwd,
        );
        const steps = [{ title: input.name, notes: null }];
        return {
          page,
          clip,
          exitCode,
          part: deck ? shotsPart(shotsOf(clip, settings.fps), steps) : undefined,
        };
      }
      const { clip } = await Capture.record(
        page,
        { url: input.kind === 'html' ? await serve(servers, input, settings) : input.url },
        settings,
        needsFrames,
        cwd,
      );
      if (!deck) return { page, clip, exitCode: 0 };
      const title = (await page.title().catch(() => '')) || input.name;
      return {
        page,
        clip,
        exitCode: 0,
        part: shotsPart(shotsOf(clip, settings.fps), [{ title, notes: null }]),
      };
    };
    const recordings = await Stream.asyncStream(
      inputs.entries(),
      async ([index, input]) => {
        enterPhase(`recording ${input.name}`);
        const page = await context.newPage();
        try {
          if (settings.browser === 'chromium') await enlargeChromeWindow(page, settings);
          // A tour may end on another tab than it started on; stills show where it ended.
          const recorded = await recordInput(page, input);
          // Stills and PDFs show the page where it ended, so they are made before it closes.
          const files = await Array.fromAsync(
            outputs.filter((output) => output.inputIndex === index),
            async (output) =>
              [
                output,
                output.format === 'pdf'
                  ? await PDF.record(
                      recorded.page,
                      output,
                      options.pdf ?? {},
                      pdfMode,
                      input.name,
                      settings,
                    )
                  : output.format === 'png'
                    ? await (settings.compare ? writeSnapshot : PNG.record)(recorded.page, output, {
                        ...settings,
                        scale: recorded.stillScale,
                      })
                    : await JPEG.record(recorded.page, output, {
                        ...settings,
                        scale: recorded.stillScale,
                      }),
              ] as const,
          );
          // A tour's frames are drawn after its stills are taken; see recordTour.
          if (recorded.draw) enterPhase(`drawing ${input.name}`);
          const clip = recorded.draw
            ? clipOf(
                (await recorded.draw()).map(({ image, durationMs }) => ({
                  png: image,
                  durationMs,
                })),
              )
            : recorded.clip;
          return { input, clip, exitCode: recorded.exitCode, files, part: recorded.part };
        } finally {
          await page.close().catch(() => {});
        }
      },
      { maxConcurrency },
    ).collect();
    // A recording of steps is drawn now, part by part: its GIF, player and PDF.
    if (deck && needsFrames) enterPhase('drawing the recording');
    const deckFiles =
      deck && needsFrames
        ? await Deck.writeDeck(
            recordings.flatMap((recording) => (recording.part ? [recording.part] : [])),
            outputs.filter((output) => output.inputIndex === null),
            {
              title: inputs.length === 1 ? inputs[0].name : 'Recording',
              panel: look!.panel,
              css: options.css ?? '',
              backdrop: options.backdrop,
              quality: settings.quality,
              player: { ...DEFAULT_PLAYER, ...options.player },
              pdf: options.pdf ?? {},
              pdfMode,
              open: () => context.newPage(),
              recordVideos: (videoOutputs, frames) =>
                Video.record(
                  videoOutputs,
                  [clipOf(frames.map(({ image, durationMs }) => ({ png: image, durationMs })))],
                  settings.fps,
                  context,
                ),
            },
          )
        : [];
    const clips = recordings.map((recording) => recording.clip);
    // Every video output from one encode: each frame goes to the browser and is decoded once. A
    // recording of steps drew its own, above.
    const videoOutputs = deckFiles.length
      ? []
      : outputs.filter((output) => output.format === 'webm' || output.format === 'mp4');
    if (videoOutputs.length) enterPhase('encoding video');
    const videos = videoOutputs.length
      ? await Video.record(videoOutputs, clips, settings.fps, context)
      : [];
    const written = new Map([
      ...recordings.flatMap((recording) => recording.files),
      ...deckFiles,
      ...videoOutputs.map((output, index) => [output, videos[index]] as const),
    ]);
    // In the order they were asked for: stills, PDFs, videos and a recording of steps are written,
    // and a GIF of pages and scripts is written now, of every clip.
    const files = await Promise.all(
      outputs.map((output) => written.get(output) ?? GIF.record(output, clips, settings.fps)),
    );
    const failedScripts = recordings.flatMap(({ input, exitCode }) =>
      input.kind === 'script' && exitCode !== 0 ? [{ path: input.path, exitCode }] : [],
    );
    // Under `compare` every file is a snapshot, compared.
    const snapshots = files.filter(
      (file): file is RecordedFile & { comparison: SnapshotComparison } => !!file.comparison,
    );
    const changedSnapshots = snapshots
      .filter((snapshot) => snapshot.comparison.status === 'changed')
      .map((snapshot) => snapshot.path);
    // Where each review goes, when asked for. A PDF report is printed from the HTML one, which is
    // removed after unless it was asked for too.
    const commentPath = options.prComment ? path.join(directory, 'comment.md') : null;
    const htmlPath = settings.report.length ? path.join(directory, 'report.html') : null;
    const reportPdfPath = settings.report.includes('pdf')
      ? path.join(directory, 'report.pdf')
      : null;
    await Promise.all([
      commentPath &&
        writeFile(
          commentPath,
          Report.renderComment(snapshots, {
            directory,
            imagesUrl: options.imagesUrl!,
            reportUrl: options.reportUrl,
          }),
        ),
      htmlPath &&
        writeFile(htmlPath, Report.render(snapshots, { directory, generatedAt: new Date() })),
    ]);
    if (htmlPath && reportPdfPath) {
      const printed = await printReport(context, htmlPath, options.pdf ?? {}, pdfMode, settings);
      await writeFile(reportPdfPath, printed.bytes);
      if (!settings.report.includes('html')) await rm(htmlPath, { force: true });
    }
    return {
      ok: failedScripts.length === 0 && changedSnapshots.length === 0,
      files,
      failedScripts,
      changedSnapshots,
      reportPath: settings.report.includes('html') ? htmlPath : null,
      reportPdfPath,
      commentPath,
    };
  } finally {
    enterPhase('closing the browser');
    await closeCompletely({
      servers: Promise.all(
        [...servers.values()].map(async (pending) => (await pending).server.close()),
      ),
      context: context.close(),
      tours: Promise.all(tourContexts.map((opened) => opened.close())),
      browser: browser.close(),
      prelaunch: shutdownPrelaunch(),
    });
  }
}

// The recording-wide look, its CSS checked by the browser before anything is recorded: a typo in
// panel.style fails now, not after every tour has run.
async function deckLook(
  context: BrowserContext,
  options: RecordOptions,
): Promise<{ panel: Panel | null; slide: Style }> {
  const page = await context.newPage();
  // Refused CSS is a refused option, as from the command line, not a crash.
  const check = (part: string, style: Style) =>
    checkStyle(page, part, style).catch((error: Error) => {
      throw Options.InvalidRecordOption({
        option: part,
        reason: error.message.replace(`${part}.`, ''),
      });
    });
  try {
    const panel = options.panel && {
      placement: options.panel.placement ?? 'below',
      height: options.panel.height ?? DEFAULT_PANEL_HEIGHT,
      style: await check('panel.style', options.panel.style ?? {}),
    };
    return {
      panel: panel || null,
      slide: await check('slide.style', options.slide?.style ?? {}),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// A page's or a script's frames as a part's shots: thinned to the frame rate, each held until the
// next, the last for the clip's lastFrameDurationMs.
function shotsOf(
  clip: Capture.Clip,
  fps: number,
): { png: Uint8Array; durationMs: number; step: number }[] {
  const kept = Capture.limitFrameRate(clip.shots, fps);
  return kept.map((shot, index) => ({
    png: shot.png,
    durationMs: kept[index + 1] ? kept[index + 1].atMs - shot.atMs : clip.lastFrameDurationMs,
    step: 0,
  }));
}

// A Markdown deck's slides, or an image, each shown in the page and shot: one step a slide, held
// for `lastFrameDuration`. They are loaded from a local origin so a slide's relative images resolve.
async function recordSlides(
  page: Page,
  input: Extract<Inputs.Input, { kind: 'slides' | 'image' }>,
  look: { slide: Style },
  settings: Settings & { css?: string },
  serveFile: (root: string, file: string) => Promise<string>,
): Promise<{
  shots: { png: Uint8Array; durationMs: number; step: number }[];
  steps: { title: string; notes: string | null }[];
  sheets: string[];
}> {
  const local = !/^[a-z]+:\/\//i.test(input.kind === 'image' ? input.location : input.path);
  const file = input.kind === 'image' ? input.location : input.path;
  const located = local ? await serveFile(path.dirname(file), file) : file;
  const slides =
    input.kind === 'image'
      ? [{ html: Slides.imageSlide(located, input.name), title: input.name, notes: null }]
      : await Slides.parseSlides(await readFile(input.path, 'utf8'));
  if (!slides.length)
    throw Inputs.UnrecordableInput({ input: input.source, reason: 'it has no slides' });
  const base = `<base href="${new URL('.', located).href}">`;
  const shots = [];
  // Each slide's own page too, for a printed recording to show as text rather than a picture.
  const sheets: string[] = [];
  for (const [index, slide] of slides.entries()) {
    const html = Slides.slidePage(slide.html, {
      css: settings.css,
      style: look.slide,
      image: input.kind === 'image',
    }).replace('<head>', `<head>${base}`);
    sheets.push(html);
    // A slide's pictures load as long as --timeout allows, as a recorded page's do.
    await page.setContent(html, { waitUntil: 'load', timeout: settings.timeout ?? 0 });
    await Capture.settled(page, settings);
    shots.push({
      png: await page.screenshot({ type: 'png' }),
      durationMs: settings.lastFrameDuration,
      step: index,
    });
  }
  return { shots, steps: slides.map(({ title, notes }) => ({ title, notes })), sheets };
}

// Chrome opens a new context's window at exactly the viewport's size, and a small one leaves the
// window no room to paint in: screenshots of it never get a frame and wait forever. The window is
// made bigger instead; the viewport stays what was asked for, emulated inside it.
async function enlargeChromeWindow(page: Page, settings: Settings): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { width: Math.max(settings.width, 1440), height: Math.max(settings.height, 900) },
    });
  } finally {
    await session.detach().catch(() => {});
  }
}

// The report as a PDF: loaded from where it was written, so the pictures it links relatively
// load, for as long as --timeout allows, as a recorded page's do.
async function printReport(
  context: BrowserContext,
  htmlPath: string,
  pdf: PdfOptions,
  mode: 'vector' | 'raster',
  settings: Settings,
): Promise<PDF.PdfDocument> {
  const page = await context.newPage();
  try {
    await page.goto(pathToFileURL(htmlPath).href, { timeout: settings.timeout ?? 0 });
    return await PDF.fromPage(page, pdf, mode, {
      title: await page.title(),
      quality: settings.quality,
    });
  } finally {
    await page.close().catch(() => {});
  }
}

// A tour, on pages of its own; its context is closed with the browser's. In a recording of steps
// it is a part whose frames the deck draws; otherwise its frames are drawn into a clip after its
// stills.
async function recordTour(
  input: Extract<Inputs.Input, { kind: 'tour' }>,
  browser: PlaywrightBrowser,
  settings: Settings,
  needsFrames: boolean,
  deck: boolean,
  prepare: (opened: Page) => Promise<void>,
  tourContexts: BrowserContext[],
): Promise<Recorded> {
  const recorded = await Tour.recordTour(input.path, {
    browser,
    settings: { ...settings, lastFrameDurationMs: settings.lastFrameDuration },
    prepare,
  });
  tourContexts.push(recorded.context);
  return {
    page: recorded.page,
    clip: { shots: [], lastFrameDurationMs: settings.lastFrameDuration },
    exitCode: 0,
    stillScale: settings.scale < 2 ? 'css' : 'device',
    draw: !deck && needsFrames ? recorded.draw : undefined,
    part: deck
      ? {
          steps: recorded.steps.map((step) => ({
            title: step.title ?? input.name,
            notes: step.notes,
          })),
          size: recorded.size,
          draw: recorded.draw,
        }
      : undefined,
  };
}

// A tour's frames are drawn with their durations already decided, so each is kept as drawn.
function clipOf(frames: { png: Uint8Array; durationMs: number }[]): Capture.Clip {
  let atMs = 0;
  const shots = frames.map(({ png, durationMs }) => {
    const shot = { png, atMs, requested: true };
    atMs += durationMs;
    return shot;
  });
  return { shots, lastFrameDurationMs: frames.at(-1)?.durationMs ?? 0 };
}

// How many pages are recorded at once: one per core, less one for Node and the browser itself,
// and no more than memory holds. availableMemory counts a container's limit, not only the host's.
function maxParallelPageProcessingAtOnce(): number {
  return Math.max(
    1,
    Math.min(availableParallelism() - 1, Math.floor(process.availableMemory() / MEMORY_PER_PAGE)),
  );
}

// A still of the page held against its baseline under `compare`: only what the comparison calls
// for is written, beside the baseline.
async function writeSnapshot(
  page: Page,
  output: Outputs.Output,
  settings: Omit<Settings, 'scale'> & { scale?: 'css' | 'device' },
): Promise<RecordedFile> {
  const bytes = await PNG.screenshot(page, settings);
  return {
    path: output.absolutePath,
    format: output.format,
    ...PNG.getDimensions(bytes),
    bytes: bytes.length,
    frames: 1,
    comparison: await snapshot(output.absolutePath, bytes, settings),
  };
}

// Compares a new screenshot with the baseline at `file`, and writes whatever that calls for: a new
// or accepted screenshot becomes the baseline, and a change not accepted gets its diff and the new
// screenshot beside it, which anything else clears away.
async function snapshot(
  file: string,
  current: Uint8Array,
  settings: Pick<Settings, 'threshold' | 'maxDiff' | 'accept'>,
): Promise<SnapshotComparison> {
  const stem = file.slice(0, -path.extname(file).length);
  const [diffPath, currentPath] = [`${stem}.diff.png`, `${stem}.new.png`];
  const image = PNG.decode(current);
  const baseline = await readFile(file).catch(() => null);
  const before = baseline && PNG.decode(baseline);
  const result = before && Diff.compare(before, image, { threshold: settings.threshold });
  const status = !result
    ? 'new'
    : result.sameSize && result.changedPixels <= settings.maxDiff
      ? 'unchanged'
      : settings.accept
        ? 'updated'
        : 'changed';
  const changed = status === 'changed';
  await Promise.all([
    status === 'new' || status === 'updated' ? writeFile(file, current) : null,
    changed ? writeFile(currentPath, current) : rm(currentPath, { force: true }),
    changed
      ? PNG.encode(Diff.draw(before!, image, result!)).then((png) => writeFile(diffPath, png))
      : rm(diffPath, { force: true }),
  ]);
  return {
    status,
    changedPixels: result?.changedPixels ?? 0,
    totalPixels: result?.totalPixels ?? image.width * image.height,
    diffPath: changed ? diffPath : null,
    currentPath: changed ? currentPath : null,
  };
}

// An HTML file is loaded over http, not file://: Chrome refuses module scripts and fetch() from
// file://, and `/style.css` there means the disk's root. Each directory gets its own server, so
// `/style.css` is its own, and its own origin, so one input's cached files and storage are never
// another's.
async function serve(
  servers: Servers,
  input: { root: string; path: string },
  settings: Settings,
): Promise<string> {
  const started = servers.get(input.root) ?? startServer(input.root, settings.port);
  servers.set(input.root, started);
  return Inputs.getFullURLOf(input.path, (await started).origin, input.root);
}

// A static server for `root`, on the first free port from `port` up.
async function startServer(
  root: string,
  port: number,
): Promise<{ server: HTTPServer; origin: string }> {
  const server = staticServer(root);
  const binding = { port, portExplicit: false };
  await bindServerToPort(server, binding);
  return { server, origin: `http://localhost:${binding.port}` };
}

function staticServer(root: string): HTTPServer {
  const server = new HTTPServer();
  server.get('/*', (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    const target = path.join(root, pathname);
    // Nothing outside the directory that was asked for, `..` or not.
    if (path.relative(root, target).startsWith('..')) {
      response.statusCode = 403;
      response.end();
    } else {
      const file = pathname.endsWith('/') ? path.join(target, 'index.html') : target;
      const stream = createReadStream(file);
      stream.on('open', () => {
        response.setHeader(
          'Content-Type',
          MIME_TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream',
        );
        stream.pipe(response);
      });
      stream.on('error', () => {
        response.statusCode = 404;
        response.end();
      });
    }
  });
  return server;
}
