import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import * as GIF from './gif.ts';
import * as PNG from './png.ts';
import { DEFAULT_PANEL_HEIGHT, PANEL_CSS, filledPanelHTML, type Panel } from './panel.ts';
import * as PDF from './pdf.ts';
import { enterPhase, progress } from './progress.ts';
import { renderPlayer, type PlayerSettings } from './player.ts';
import { writePptx, type OfficeStep } from './pptx.ts';
import { writeDocx, type DocxPage } from './docx.ts';
import { DEFAULT_LOOK, compose, type ComposedFrame, type ComposeOptions } from './tour/compose.ts';
import type { Beat } from './tour/timeline.ts';
import type { Browser, Page } from 'playwright-core';
import * as Outputs from './outputs.ts';
import type { Output } from './outputs.ts';
import type { RecordedFile } from './index.ts';
import * as CSS from './css.ts';
import * as JPEG from './jpeg.ts';

/**
 * What a part of a recording can be drawn with: onto the recording's `canvas`, with its steps'
 * `panel`, in its `backdrop`, as `png` or `jpeg`, with the recording's `css` under the part's own.
 *
 * ```ts
 * const extra: DrawExtra = { canvas: { width: 1280, height: 794 }, type: 'jpeg', quality: 85 };
 * ```
 */
export type DrawExtra = Pick<
  ComposeOptions,
  'canvas' | 'panel' | 'type' | 'quality' | 'backdrop'
> & {
  css?: string;
};

/**
 * One input of a recording, recorded: its steps, the size it is drawn at, and `draw`. A tour is
 * one; so is a page, a script, a Markdown deck (a step a slide) and an image.
 *
 * ```ts
 * import type { Part } from './deck.ts';
 *
 * // Defined, not invoked: needs a recorded part.
 * async function count(part: Part) {
 *   return (await part.draw({})).length;
 * }
 * ```
 */
export interface Part {
  /** Its steps, in order, each titled. */
  steps: { title: string; notes: string | null }[];
  /** The size it is drawn at, frame included. */
  size: { width: number; height: number };
  /** Draws its frames. */
  draw: (extra: DrawExtra) => Promise<ComposedFrame[]>;
  /**
   * A page per step to print in place of its last frame: a slide's own HTML, so a PDF keeps its
   * text as text. Absent, each step prints as the picture of its last frame.
   */
  sheets?: string[];
}

/**
 * A part made of screenshots held in turn — a page's or a script's frames, a deck's slides, an
 * image — drawn through the same compositor as a tour's, with no pointer and no frame of its own.
 * `step` is each shot's step among `steps`.
 *
 * ```ts
 * import { shotsPart } from './deck.ts';
 * import type { Browser } from 'playwright-core';
 *
 * // Defined, not invoked: draws in a real browser.
 * function slide(browser: Browser, png: Uint8Array) {
 *   return shotsPart(browser, [{ png, durationMs: 3000, step: 0 }], [{ title: 'Why', notes: null }], {
 *     viewport: { width: 1280, height: 720 },
 *     scale: 1,
 *     fps: 10,
 *   });
 * }
 * ```
 */
export function shotsPart(
  browser: Browser,
  shots: { png: Uint8Array; durationMs: number; step: number }[],
  steps: { title: string; notes: string | null }[],
  settings: {
    viewport: { width: number; height: number };
    scale: number;
    fps: number;
    prepare?: (page: Page) => Promise<void>;
  },
): Part {
  const { width, height } = settings.viewport;
  const beats: Beat[] = shots.map((shot, index) => ({
    shot: index,
    cursor: null,
    touches: [],
    menu: null,
    ripple: null,
    camera: { x: 0, y: 0, width, height },
    caption: null,
    highlight: null,
    keys: null,
    chapter: null,
    tabs: { titles: [''], active: 0, url: '' },
    step: shot.step,
    durationMs: shot.durationMs,
  }));
  return {
    steps,
    size: settings.viewport,
    draw: ({ css, ...extra }) =>
      compose(
        browser,
        shots.map((shot) => shot.png),
        beats,
        {
          viewport: settings.viewport,
          scale: settings.scale,
          frame: 'none',
          pointer: 'cursor',
          look: css ? { ...DEFAULT_LOOK, css } : DEFAULT_LOOK,
          fps: settings.fps,
          prepare: settings.prepare,
          ...extra,
        },
      ),
  };
}

/**
 * The size every part of a recording is drawn at: the biggest of them, so a phone, a browser
 * window and a slide sit centered on one canvas, each on the backdrop around it.
 *
 * ```ts
 * import { canvasOf } from './deck.ts';
 *
 * canvasOf([{ width: 450, height: 948 }, { width: 1280, height: 794 }]); // { width: 1280, height: 948 }
 * ```
 */
export function canvasOf(sizes: { width: number; height: number }[]): {
  width: number;
  height: number;
} {
  return {
    width: Math.max(...sizes.map((size) => size.width)),
    height: Math.max(...sizes.map((size) => size.height)),
  };
}

/**
 * Draws every part onto one canvas and writes the recording's outputs: a GIF or video, its steps'
 * panel drawn in when `panel` is set (videos are encoded by `recordVideos`); the HTML player, whose
 * panel is its own, live; and a PDF, a page a step (see {@link printSteps}). Parts are drawn once
 * per kind of output, never per file.
 *
 * ```ts
 * import { writeDeck } from './deck.ts';
 * import type { Part } from './deck.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: draws in a real browser and writes files.
 * async function write(parts: Part[], open: () => Promise<Page>) {
 *   return await writeDeck(parts, [{ format: 'html', absolutePath: '/out/demo.html', inputIndex: null }], {
 *     title: 'Demo', panel: null, css: '', backdrop: '#e8ebf0', quality: 85,
 *     player: { advance: 'click', loop: false, autoplay: true, assets: 'inline' },
 *     pdf: {}, pdfMode: 'vector', open, recordVideos: async () => [],
 *   });
 * }
 * ```
 */
export async function writeDeck(
  parts: Part[],
  outputs: Output[],
  settings: {
    title: string;
    panel: Panel | null;
    css: string;
    backdrop: string | undefined;
    quality: number;
    player: PlayerSettings;
    /** How `pdf` outputs are printed, and whether this engine prints vector or raster. */
    pdf: PDF.PdfOptions;
    pdfMode: 'vector' | 'raster';
    /** A page to print in. */
    open: () => Promise<Page>;
    /** Encodes `.webm` and `.mp4` outputs from the frames the GIF is drawn from, a file each. */
    recordVideos: (outputs: Output[], frames: ComposedFrame[]) => Promise<RecordedFile[]>;
  },
): Promise<[Output, RecordedFile][]> {
  const canvas = canvasOf(parts.map((part) => part.size));
  const steps = parts.flatMap((part) => part.steps);
  const titles = steps.map((step) => step.title);
  const offsets = parts.map((_, index) =>
    parts.slice(0, index).reduce((sum, part) => sum + part.steps.length, 0),
  );
  // Every part in turn, its steps numbered among the whole recording's.
  const drawAll = async (
    panel: (offset: number) => DrawExtra['panel'],
    kind: Pick<DrawExtra, 'type' | 'quality'>,
  ) => {
    const frames: ComposedFrame[] = [];
    for (const [index, part] of parts.entries()) {
      frames.push(
        ...(await part.draw({
          canvas,
          panel: panel(offsets[index]),
          backdrop: settings.backdrop,
          css: settings.css,
          ...kind,
        })),
      );
    }
    return frames;
  };
  const written: [Output, RecordedFile][] = [];
  const gifs = outputs.filter((output) => output.format === 'gif');
  const videos = outputs.filter((output) => output.format === 'webm' || output.format === 'mp4');
  // A GIF and a video show the same frames, so they are drawn once for both.
  const animationFrames =
    gifs.length || videos.length
      ? await drawAll((offset) => settings.panel && { ...settings.panel, titles, offset }, {
          type: 'png',
        })
      : [];
  if (videos.length) {
    const files = await settings.recordVideos(videos, animationFrames);
    written.push(...videos.map((output, index): [Output, RecordedFile] => [output, files[index]]));
  }
  if (gifs.length) {
    enterPhase(`encoding ${path.basename(gifs[0].absolutePath)}`, animationFrames.length);
    const encoder = new GIF.Encoder();
    let size = { width: 0, height: 0 };
    for (const frame of animationFrames) {
      const image = PNG.decode(frame.image);
      size = { width: image.width, height: image.height };
      encoder.add(image, frame.durationMs);
      progress.done += 1;
      // Back to the event loop between frames, as GIF.record does, so the CLI shows how far.
      await yieldToLoop();
    }
    const gif = encoder.finish();
    for (const output of gifs) {
      written.push([output, await Outputs.write(output, gif, { ...size, frames: encoder.frames })]);
    }
  }
  const pages = outputs.filter((output) => output.format === 'html');
  const documents = outputs.filter((output) => output.format === 'pdf');
  const offices = outputs.filter((output) => output.format === 'pptx' || output.format === 'docx');
  // The player and a printed recording always have a panel: the player's controls live there,
  // and a page has its step's title. Without one asked for, below. Their frames are drawn once.
  const panel: Panel = settings.panel ?? {
    placement: 'below',
    height: DEFAULT_PANEL_HEIGHT,
    style: {},
  };
  const frames =
    pages.length || documents.length || offices.length
      ? await drawAll((offset) => ({ ...panel, titles, offset, drawn: false }), {
          type: 'jpeg',
          quality: settings.quality,
        })
      : [];
  if (documents.length) {
    const sheets = parts.flatMap((part) =>
      part.sheets
        ? part.sheets.map((html) => ({ html, size: part.size }))
        : part.steps.map(() => null),
    );
    const printed = await printSteps(steps, frames, sheets, {
      canvas,
      panel,
      css: settings.backdrop
        ? `html, body { background: ${settings.backdrop}; }\n${settings.css}`
        : settings.css,
      title: settings.title,
      pdf: settings.pdf,
      mode: settings.pdfMode,
      quality: settings.quality,
      open: settings.open,
    });
    for (const output of documents) {
      const { width, height, pageCount } = printed;
      written.push([
        output,
        await Outputs.write(output, printed.bytes, { width, height, frames: pageCount }),
      ]);
    }
  }
  if (offices.length) {
    const pictured: OfficeStep[] = steps.map((step, index) => {
      const last = frames.findLast((frame) => frame.step === index);
      return {
        title: step.title,
        caption: last?.caption ?? null,
        notes: step.notes,
        jpeg: last?.image ?? new Uint8Array(0),
      };
    });
    const shown = pictured.filter((step) => step.jpeg.length);
    for (const output of offices) {
      const bytes =
        output.format === 'pptx'
          ? writePptx(settings.title, shown, {
              canvas,
              panel: {
                placement: panel.placement,
                height: panel.height,
                background: panel.style.background ?? panel.style['background-color'],
                color: panel.style.color,
              },
            })
          : writeDocx(settings.title, shown, documentPage(settings.pdf));
      written.push([
        output,
        await Outputs.write(output, bytes, {
          width: canvas.width,
          height: canvas.height + (output.format === 'pptx' ? panel.height : 0),
          frames: shown.length,
        }),
      ]);
    }
  }
  if (pages.length) {
    for (const output of pages) {
      const assetsDir = `${path.basename(output.absolutePath, path.extname(output.absolutePath))}-files`;
      const { html, files } = renderPlayer({
        title: settings.title,
        size: canvas,
        steps,
        frames,
        panel,
        css: settings.backdrop
          ? `html, body { background: ${settings.backdrop}; }\n${settings.css}`
          : settings.css,
        player: settings.player,
        assetsDir,
      });
      const directory = path.join(path.dirname(output.absolutePath), assetsDir);
      await rm(directory, { recursive: true, force: true });
      if (files.length) await mkdir(directory, { recursive: true });
      await Promise.all(
        files.map((file) => writeFile(path.join(directory, file.name), file.bytes)),
      );
      const player = await Outputs.write(output, new TextEncoder().encode(html), {
        width: canvas.width,
        height: canvas.height,
        frames: frames.length,
      });
      // The player is its page and its pictures beside it.
      const assetBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
      written.push([output, { ...player, bytes: player.bytes + assetBytes }]);
    }
  }
  return written;
}

/**
 * A recording printed, a page a step: each step's last frame — or, for a slide, the slide itself,
 * so its text stays text — with the panel above or below it as the player shows it, notes
 * included. `fit` paper (the default) makes each page exactly a step; a named paper fits the steps
 * to its width. Vector in chromium; elsewhere each step's page is pictured whole, so page breaks
 * always fall between steps.
 *
 * ```ts
 * import { printSteps } from './deck.ts';
 *
 * // Defined, not invoked: prints in a real browser.
 * async function handout(open: () => Promise<import('playwright-core').Page>) {
 *   return await printSteps([{ title: 'One', notes: null }], [], [null], {
 *     canvas: { width: 640, height: 360 },
 *     panel: { placement: 'below', height: 96, style: {} },
 *     css: '', title: 'Demo', pdf: {}, mode: 'vector', quality: 90, open,
 *   });
 * }
 * ```
 */
export async function printSteps(
  steps: { title: string; notes: string | null }[],
  frames: ComposedFrame[],
  sheets: ({ html: string; size: { width: number; height: number } } | null)[],
  settings: {
    canvas: { width: number; height: number };
    panel: Panel;
    css: string;
    title: string;
    pdf: PDF.PdfOptions;
    mode: 'vector' | 'raster';
    quality: number;
    open: () => Promise<Page>;
  },
): Promise<PDF.PdfDocument> {
  const { canvas, panel } = settings;
  const sheet = { width: canvas.width, height: canvas.height + panel.height };
  const titles = steps.map((step) => step.title);
  const lastOf = steps.map((_, step) => frames.findLast((frame) => frame.step === step));
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(settings.title)}</title><style>
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; }
.sheet { width: ${sheet.width}px; height: ${sheet.height}px; display: flex; flex-direction: column; overflow: hidden; break-after: page; }
.sheet:last-child { break-after: auto; }
.view { width: ${canvas.width}px; height: ${canvas.height}px; flex: none; display: grid; place-items: center; overflow: hidden; }
.view img { display: block; width: 100%; height: 100%; }
.view iframe { border: 0; display: block; background: #fff; }
#panel { height: ${panel.height}px; flex: none; }
${PANEL_CSS}
</style><style>${settings.css.replace(/<\/style/gi, '<\\/style')}</style></head><body>
${steps
  .map((step, index) => {
    const frame = lastOf[index];
    const page = sheets[index];
    // A slide is shown at the size it was drawn, centered on the canvas as its frame shows it.
    const view = page
      ? `<iframe srcdoc="${escape(page.html)}" width="${page.size.width}" height="${page.size.height}"></iframe>`
      : frame
        ? `<img alt="${escape(step.title)}" src="data:image/jpeg;base64,${Buffer.from(frame.image).toString('base64')}">`
        : '';
    const filled = filledPanelHTML(titles, index, frame?.caption ?? null, step.notes);
    const styled = filled.replace(
      '<div id="panel"',
      `<div id="panel" style="${escape(styleText(panel.style))}"`,
    );
    return `<section class="sheet">${panel.placement === 'above' ? styled : ''}<div class="view">${view}</div>${panel.placement === 'below' ? styled : ''}</section>`;
  })
  .join('\n')}
</body></html>`;
  const page = await settings.open();
  try {
    await page.setViewportSize({ width: sheet.width, height: sheet.height });
    await page.setContent(html, { waitUntil: 'load' });
    if (settings.mode === 'raster') return await pictureSteps(page, steps.length, sheet, settings);
    const paper = settings.pdf.paper ?? 'fit';
    const named = paper !== 'fit';
    const size = named
      ? typeof paper === 'string'
        ? PDF.PAPERS[paper]
        : paper
      : { width: sheet.width, height: sheet.height };
    const turned =
      named && settings.pdf.landscape ? { width: size.height, height: size.width } : size;
    const margin = settings.pdf.margin;
    const side = (key: 'top' | 'right' | 'bottom' | 'left') =>
      CSS.toPixels(
        typeof margin === 'object' && margin !== null ? (margin[key] ?? 0) : (margin ?? 0),
      );
    // On paper, a step shrinks (or grows) to fit the page inside its margins, both ways, as the
    // printer's own scale does it: one step a page, always.
    const fitted = named
      ? Math.min(
          2,
          Math.max(
            0.1,
            Math.min(
              (CSS.toPixels(turned.width) - side('left') - side('right')) / sheet.width,
              (CSS.toPixels(turned.height) - side('top') - side('bottom')) / sheet.height,
            ),
          ),
        )
      : 1;
    return await PDF.fromPage(
      page,
      {
        ...settings.pdf,
        paper: turned,
        landscape: false,
        scale: Math.min(2, Math.max(0.1, fitted * (settings.pdf.scale ?? 1))),
      },
      'vector',
      { title: settings.title, quality: settings.quality },
    );
  } finally {
    await page.close().catch(() => {});
  }
}

// Raster: each step's page pictured whole, then laid on paper — its own size, or a named paper
// with the picture fitted inside the margins.
async function pictureSteps(
  page: Page,
  count: number,
  sheet: { width: number; height: number },
  settings: { pdf: PDF.PdfOptions; title: string; quality: number },
): Promise<PDF.PdfDocument> {
  const paper = settings.pdf.paper ?? 'fit';
  const base = paper === 'fit' ? sheet : typeof paper === 'string' ? PDF.PAPERS[paper] : paper;
  const size = {
    width: CSS.toPixels(paper !== 'fit' && settings.pdf.landscape ? base.height : base.width),
    height: CSS.toPixels(paper !== 'fit' && settings.pdf.landscape ? base.width : base.height),
  };
  const margin = settings.pdf.margin;
  const side = (key: 'top' | 'right' | 'bottom' | 'left') =>
    CSS.toPixels(
      typeof margin === 'object' && margin !== null ? (margin[key] ?? 0) : (margin ?? 0),
    );
  const inner = {
    width: size.width - side('left') - side('right'),
    height: size.height - side('top') - side('bottom'),
  };
  const fit = Math.min(inner.width / sheet.width, inner.height / sheet.height);
  const drawn = { width: sheet.width * fit, height: sheet.height * fit };
  const images: PDF.PdfImage[] = [];
  const sections = page.locator('.sheet');
  for (let index = 0; index < count; index++) {
    const jpeg = await sections.nth(index).screenshot({ type: 'jpeg', quality: settings.quality });
    images.push({
      jpeg,
      pixels: JPEG.getDimensions(jpeg),
      page: size,
      at: {
        x: side('left') + (inner.width - drawn.width) / 2,
        y: side('top') + (inner.height - drawn.height) / 2,
        ...drawn,
      },
    });
  }
  return {
    bytes: PDF.encode(images, { title: settings.title }),
    pageCount: images.length,
    width: Math.round(size.width),
    height: Math.round(size.height),
  };
}

// A document's page: the PDF's paper and margins when they name one, else A4 with inch margins.
function documentPage(pdf: PDF.PdfOptions): DocxPage {
  const paper = pdf.paper ?? 'fit';
  const base =
    paper === 'fit' ? PDF.PAPERS.A4 : typeof paper === 'string' ? PDF.PAPERS[paper] : paper;
  const sideways = paper !== 'fit' && pdf.landscape;
  const side = (key: 'top' | 'right' | 'bottom' | 'left') =>
    pdf.margin === undefined
      ? 96
      : CSS.toPixels(typeof pdf.margin === 'object' ? (pdf.margin[key] ?? 0) : pdf.margin);
  return {
    width: CSS.toPixels(sideways ? base.height : base.width),
    height: CSS.toPixels(sideways ? base.width : base.height),
    margin: { top: side('top'), right: side('right'), bottom: side('bottom'), left: side('left') },
  };
}

function styleText(style: Record<string, string | number | undefined>): string {
  return Object.entries(style)
    .filter(([, value]) => value !== undefined)
    .map(([property, value]) => `${property}: ${value}`)
    .join('; ');
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
