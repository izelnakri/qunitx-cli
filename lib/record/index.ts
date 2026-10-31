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
import * as Browser from '../setup/browser.ts';
import * as Capture from './capture.ts';
import * as Diff from './diff.ts';
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
import { Stream } from '../stream/index.ts';
import { HTTPServer, MIME_TYPES } from '../web/index.ts';
import * as Failure from '../result/failure.ts';
import { bindServerToPort } from '../setup/bind-server-to-port.ts';
import { closeCompletely } from '../utils/close-with-grace.ts';
import { withLoopAlive } from '../utils/with-loop-alive.ts';
import { shutdownPrelaunch } from '../chrome/prelaunch.ts';
import type { ConsoleOption } from '../console.ts';
import type { Page } from 'playwright-core';

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
  /** CSS selectors of regions to paint over in every still: clocks, avatars, ads. */
  mask?: string[];
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
  /** The red-on-grey picture of what changed, when it did and was not accepted. */
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
 * const result: RecordResult = { ok: true, files: [], failedScripts: [], changedSnapshots: [], notices: [] };
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

  /** What a file was written without, and why: a form field left printed, not fillable. */
  notices: Notice[];
}

// What a file was written without, and why.
type Notice = { path: string; message: string };

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
  // The JS API's options are held to the command line's rules: an fps of 0 is a mistake to name,
  // not a division to attempt.
  Options.validate(options);
  const cwd = options.cwd ?? process.cwd();
  const settings = Options.from(options);
  const inputs = await Inputs.resolve(sources, cwd);
  const outputs = Outputs.plan(
    options.formats ?? (settings.compare ? ['png'] : []),
    inputs,
    path.resolve(cwd, options.output ?? '.'),
  );
  if (Outputs.UnknownFormat.is(outputs)) throw outputs;
  const notPng = outputs.find((output) => output.format !== 'png');
  if (settings.compare && notPng) throw CompareNeedsPng({ path: notPng.absolutePath });
  // Whether this engine can print as asked is known now, before anything is recorded.
  const pdfMode = outputs.some((output) => output.format === 'pdf')
    ? PDF.getMode(options.pdf ?? {}, settings.browser)
    : 'raster';
  if (PDF.UnprintablePdf.is(pdfMode)) {
    throw Options.InvalidRecordOption({ option: 'pdf', reason: pdfMode.data.reason });
  }
  // Made before the browser launches: a directory that cannot be written to fails now, not after
  // every input has been recorded.
  await Promise.all(
    [...new Set(outputs.map((output) => path.dirname(output.absolutePath)))].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );

  const needsFrames = outputs.some((output) => Outputs.isAnimated(output.format));
  const browser = await Browser.launch({ browser: settings.browser });
  const servers: Servers = new Map();
  const context = await browser.newContext({
    viewport: { width: settings.width, height: settings.height },
    deviceScaleFactor: settings.scale,
  });
  try {
    // Frames are sampled on a clock, so a capture shares the CPU with no other page or it drops
    // them, and two scripts' console output would interleave. Stills and PDFs of pages need
    // neither, so those pages are recorded side by side.
    const maxConcurrency =
      needsFrames || inputs.some((input) => input.kind === 'script')
        ? 1
        : maxParallelPageProcessingAtOnce();
    const recordings = await Stream.asyncStream(
      inputs.entries(),
      async ([index, input]) => {
        const page = await context.newPage();
        try {
          if (settings.browser === 'chromium') await enlargeChromeWindow(page, settings);
          const { clip, exitCode } = await Capture.record(
            page,
            input.kind === 'script'
              ? { script: input.path }
              : { url: input.kind === 'html' ? await serve(servers, input, settings) : input.url },
            settings,
            needsFrames,
            cwd,
          );
          // Stills and PDFs show the page where it ended, so they are made before it closes.
          const made = await Array.fromAsync(
            outputs.filter((output) => output.inputIndex === index),
            async (output) =>
              output.format === 'pdf'
                ? await recordPdf(page, output, options.pdf ?? {}, pdfMode, input.name, settings)
                : {
                    output,
                    file:
                      output.format === 'png'
                        ? await (settings.compare ? writeSnapshot : PNG.record)(
                            page,
                            output,
                            settings,
                          )
                        : await JPEG.record(page, output, settings),
                    notices: [],
                  },
          );
          const files = made.map(({ output, file }) => [output, file] as const);
          const notices = made.flatMap(({ notices }) => notices);
          return { input, clip, exitCode, files, notices };
        } finally {
          await page.close().catch(() => {});
        }
      },
      { maxConcurrency },
    ).collect();
    const clips = recordings.map((recording) => recording.clip);
    // Every video output from one encode: each frame goes to the browser and is decoded once.
    const videoOutputs = outputs.filter(
      (output) => output.format === 'webm' || output.format === 'mp4',
    );
    const videos = videoOutputs.length
      ? await Video.record(videoOutputs, clips, settings.fps, context)
      : [];
    const filesByOutput = new Map([
      ...recordings.flatMap((recording) => recording.files),
      ...videoOutputs.map((output, index) => [output, videos[index]] as const),
    ]);
    // In the order they were asked for: stills, PDFs and videos are written, and a GIF is written
    // now, of every clip.
    const files = await Promise.all(
      outputs.map((output) =>
        output.format === 'gif'
          ? GIF.record(output, clips, settings.fps)
          : filesByOutput.get(output)!,
      ),
    );
    const failedScripts = recordings.flatMap(({ input, exitCode }) =>
      input.kind === 'script' && exitCode !== 0 ? [{ path: input.path, exitCode }] : [],
    );
    const changedSnapshots = files.flatMap((file) =>
      file.comparison?.status === 'changed' ? [file.path] : [],
    );
    return {
      ok: failedScripts.length === 0 && changedSnapshots.length === 0,
      files,
      failedScripts,
      changedSnapshots,
      notices: recordings.flatMap((recording) => recording.notices),
    };
  } finally {
    await closeCompletely({
      servers: Promise.all(
        [...servers.values()].map(async (pending) => (await pending).server.close()),
      ),
      context: context.close(),
      browser: browser.close(),
      prelaunch: shutdownPrelaunch(),
    });
  }
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

// A PDF of the page, with its notices put to the file they are about.
async function recordPdf(
  page: Page,
  output: Outputs.Output,
  pdf: PdfOptions,
  mode: 'vector' | 'raster',
  name: string,
  settings: Settings,
): Promise<{ output: Outputs.Output; file: RecordedFile; notices: Notice[] }> {
  const { file, notices } = await PDF.record(page, output, pdf, mode, name, settings);
  return { output, file, notices: notices.map((message) => ({ path: file.path, message })) };
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
  settings: Settings,
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

// Compares a new screenshot with the baseline at `file`, and writes whatever that calls for.
async function snapshot(
  file: string,
  current: Uint8Array,
  settings: Settings,
): Promise<SnapshotComparison> {
  const stem = file.slice(0, -path.extname(file).length);
  const diffPath = `${stem}.diff.png`;
  const currentPath = `${stem}.new.png`;
  const clearReview = () =>
    Promise.all([diffPath, currentPath].map((stale) => rm(stale, { force: true })));
  const image = PNG.decode(current);
  const totalPixels = image.width * image.height;
  const baseline = await readFile(file).catch(() => null);
  if (!baseline) {
    await writeFile(file, current);
    await clearReview();
    return { status: 'new', changedPixels: 0, totalPixels, diffPath: null, currentPath: null };
  }

  const result = Diff.compare(PNG.decode(baseline), image, {
    threshold: settings.threshold,
  });
  if (result.sameSize && result.changedPixels <= settings.maxDiff) {
    await clearReview();
    return {
      status: 'unchanged',
      changedPixels: result.changedPixels,
      totalPixels,
      diffPath: null,
      currentPath: null,
    };
  } else if (settings.accept) {
    await writeFile(file, current);
    await clearReview();
    return {
      status: 'updated',
      changedPixels: result.changedPixels,
      totalPixels,
      diffPath: null,
      currentPath: null,
    };
  }
  await Promise.all([
    writeFile(currentPath, current),
    result.diff
      ? PNG.encode(result.diff).then((png) => writeFile(diffPath, png))
      : rm(diffPath, { force: true }),
  ]);
  return {
    status: 'changed',
    changedPixels: result.changedPixels,
    totalPixels,
    diffPath: result.diff ? diffPath : null,
    currentPath,
  };
}

// An HTML file is loaded over http, not file://: Chrome refuses module scripts and fetch() from
// file://, and `/style.css` there means the disk's root. Each directory gets its own server, so
// `/style.css` is its own, and its own origin, so one input's cached files and storage are never
// another's.
async function serve(
  servers: Servers,
  input: Extract<Inputs.Input, { kind: 'html' }>,
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
