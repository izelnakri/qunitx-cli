import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as PNG from '../../lib/record/png.ts';
import * as Browser from '../../lib/setup/browser.ts';
import * as QUnitX from '../../lib/api/index.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import { execute as shell, shellFails } from '../helpers/shell.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import { decodeGif } from '../helpers/gif-decode.ts';
import { parsePdf } from '../helpers/pdf-parse.ts';
import { parseWebM } from '../helpers/video-parse.ts';

import { unzip } from '../helpers/unzip.ts';
import { CHROME_HEIGHT } from '../../lib/record/tour/index.ts';
import { DEFAULT_PANEL_HEIGHT } from '../../lib/record/panel.ts';
import '../helpers/custom-asserts.ts';

// Several inputs as the steps of one recording: a Markdown deck, an image and a tour, drawn onto
// one canvas with a steps panel into a GIF, and played as an HTML player driven like a viewer.

const CLI = path.resolve('cli.ts');
const BROWSER = (process.env.QUNITX_BROWSER || 'chromium') as 'chromium' | 'firefox' | 'webkit';

const solid = (width: number, height: number, rgb: number[]) =>
  PNG.encode({
    width,
    height,
    data: new Uint8Array(width * height * 4).map((_, index) => [...rgb, 255][index % 4]),
  });
const near = (actual: number[], expected: number[], tolerance = 30) =>
  actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);

// A deck of two slides (the first with a relative image), a picture, and a tour of two steps whose
// caption goes to the panel, written into `dir`.
async function writeDeck(dir: string, tourOptions = "{ caption: { placement: 'panel' } }") {
  await fs.writeFile(path.join(dir, 'dot.png'), await solid(40, 40, [255, 0, 0]));
  await fs.writeFile(path.join(dir, 'photo.png'), await solid(80, 40, [0, 120, 255]));
  await fs.writeFile(
    path.join(dir, 'deck.md'),
    '# One\n\n![dot](dot.png)\n\n---\n\n## Two\n\nNote: n2\n',
  );
  await fs.writeFile(
    path.join(dir, 'page.html'),
    '<!doctype html><title>App</title><body style="margin:0;background:#fff"><button id="go">Go</button>',
  );
  await fs.writeFile(
    path.join(dir, 'app.tour.ts'),
    `export default {
      options: ${tourOptions},
      run: async (t) => {
        await t.goto('${pathToFileURL(path.join(dir, 'page.html')).href}');
        await t.step('Three');
        await t.caption('Hello');
        await t.wait(400);
        await t.step('Four', { notes: 'n4' });
        await t.caption(null);
        await t.wait(400);
      },
    };`,
  );
}

module('Commands | record | decks', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('a deck, an image and a tour are steps of one GIF: one canvas, one panel, every part styled', async (assert, testMetadata) => {
    await using dir = await tempDir('record-deck-gif');
    await writeDeck(dir.path, "{ frame: 'browser', caption: { placement: 'panel' } }");
    await fs.writeFile(
      path.join(dir.path, 'brand.css'),
      '#panel { background: rgb(0, 0, 255); } #panel .step.active { background: rgb(255, 0, 0); } .slide { background: rgb(0, 200, 0); }',
    );
    await shell(
      `node ${CLI} record deck.md photo.png app.tour.ts -w 320 -h 200 -f deck.gif --panel=above --backdrop=rgb(255,200,0) --css=brand.css --last-frame-duration 300 --output=${dir.path}`,
      { ...moduleMetadata, ...testMetadata, cwd: dir.path },
    );
    const gif = decodeGif(await fs.readFile(path.join(dir.path, 'deck.gif')));
    const at = (frame: number, x: number, y: number) => {
      const offset = (y * gif.width + x) * 4;
      return [...gif.frames[frame].rgba.subarray(offset, offset + 3)];
    };
    const panel = DEFAULT_PANEL_HEIGHT;
    const band = CHROME_HEIGHT / 2; // a slide is centered on the taller browser window's canvas
    // Where the panel's active (red) step dot is, by its leftmost pixel.
    const activeDot = (frame: number) => {
      for (let x = 0; x < gif.width; x++) {
        for (let y = 50; y < panel; y++) if (near(at(frame, x, y), [255, 0, 0])) return x;
      }
      return -1;
    };
    // Text in the panel: anything far from its blue that is not the red active dot.
    const light = (frame: number) => {
      let count = 0;
      for (let y = 0; y < panel; y++) {
        for (let x = 0; x < gif.width; x++) {
          const [red, green, blue] = at(frame, x, y);
          if (red + green + (255 - blue) > 150 && !near([red, green, blue], [255, 0, 0])) count++;
        }
      }
      return count;
    };
    const dots = gif.frames.map((_, frame) => activeDot(frame));
    const first = dots[0];
    const stepOf = (frame: number) => Math.round((dots[frame] - first) / 14);

    assert.deepEqual(
      [gif.width, gif.height],
      [320, 200 + CHROME_HEIGHT + panel],
      'the biggest part, and the panel',
    );
    assert.true(near(at(0, 300, 40), [0, 0, 255]), 'the panel, in the css color');
    assert.true(near(at(0, 160, panel + 10), [255, 200, 0]), 'the backdrop around a smaller part');
    assert.true(near(at(0, 300, panel + band + 150), [0, 200, 0]), 'the slide, in the css color');
    assert.true(
      gif.frames.slice(0, 2).some((frame) => {
        let red = 0;
        for (let index = 0; index < frame.rgba.length; index += 4) {
          if (frame.rgba[index] > 220 && frame.rgba[index + 1] < 40 && frame.rgba[index + 2] < 40)
            red++;
        }
        return red > 40 * 40 * 0.8;
      }),
      "the slide's relative image, loaded",
    );
    assert.deepEqual(
      [...new Set(gif.frames.map((_, frame) => stepOf(frame)))],
      [0, 1, 2, 3, 4],
      `the active dot walks through every step in turn (${dots.join(' ')})`,
    );
    const three = gif.frames.findIndex((_, frame) => stepOf(frame) === 3);
    const four = gif.frames.findIndex((_, frame) => stepOf(frame) === 4);
    assert.true(light(three) > light(four) + 30, "the tour's caption, in the panel, on its step");
    assert.true(
      near(at(four, 300, panel + 10), [222, 225, 230], 20),
      'and the tour in its browser window',
    );
  });

  test('the HTML player steps through by keys, dots and links, and as a folder plays on and loops', async (assert, testMetadata) => {
    await using dir = await tempDir('record-deck-player');
    await writeDeck(dir.path);
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    await Promise.all([
      shell(
        `node ${CLI} record deck.md app.tour.ts -w 240 -h 150 -f deck.html --last-frame-duration 300 --output=${dir.path}`,
        metadata,
      ),
      shell(
        `node ${CLI} record deck.md app.tour.ts -w 240 -h 150 -f auto.html --last-frame-duration 300 --advance=auto --loop --html-assets=files --output=${dir.path}`,
        metadata,
      ),
    ]);
    const assets = await fs.readdir(path.join(dir.path, 'auto-files'));
    const permit = await acquireBrowser();
    const browser = await Browser.launch({ browser: BROWSER });
    const errors: string[] = [];
    try {
      const context = await browser.newContext({ viewport: { width: 600, height: 500 } });
      const open = async (
        file: string,
        reducedMotion: 'reduce' | 'no-preference' = 'no-preference',
      ) => {
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        await page.emulateMedia({ reducedMotion });
        const [name, hash = ''] = file.split('#');
        await page.goto(pathToFileURL(path.join(dir.path, name)).href + (hash && `#${hash}`));
        return page;
      };
      const state = (page: Awaited<ReturnType<typeof open>>) =>
        page.evaluate(() => {
          const root = document.getElementById('player')!;
          const text = (selector: string) =>
            document.querySelector(`#panel ${selector}`)!.textContent;
          return {
            step: Number(root.dataset.step),
            frame: Number(root.dataset.frame),
            playing: root.dataset.playing === 'true',
            title: text('.title'),
            caption: text('.caption'),
            notes: text('.notes'),
            hash: location.hash,
            dots: document.querySelectorAll('#panel .step').length,
          };
        });

      const page = await open('deck.html');
      const start = await state(page);
      await page.waitForFunction(
        () => document.getElementById('player')!.dataset.playing === 'false',
      );
      const waited = await state(page);
      await page.keyboard.press('ArrowRight');
      const second = await state(page);
      await page.keyboard.press('End');
      const last = await state(page);
      await page.keyboard.press('Home');
      const home = await state(page);
      await page.click('#panel .step >> nth=2');
      await page.waitForFunction(
        () => document.querySelector('#panel .caption')!.textContent === 'Hello',
      );
      const third = await state(page);
      const linked = await open('deck.html#4');
      const deep = await state(linked);
      const reduced = await open('deck.html#3', 'reduce');
      const still = await state(reduced);
      const lastOfThree = await reduced.evaluate(() =>
        (
          JSON.parse(document.getElementById('recording')!.textContent!).frames as { s: number }[]
        ).findLastIndex((frame) => frame.s === 2),
      );
      const auto = await open('auto.html');
      const seen = new Set<number>();
      for (let tries = 0; tries < 80 && !(seen.has(3) && (await state(auto)).step === 0); tries++) {
        seen.add((await state(auto)).step);
        await auto.waitForTimeout(100);
      }
      const looped = await state(auto);
      await auto.keyboard.press('k');
      const paused = await state(auto);
      await auto.keyboard.press('K');
      const resumed = await state(auto);
      // Embedded where it cannot write its URL: a sandboxed frame of a page that shares it.
      const host = await context.newPage();
      host.on('pageerror', (error) => errors.push(error.message));
      const srcdoc = (await fs.readFile(path.join(dir.path, 'deck.html'), 'utf8'))
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
      await host.setContent(`<iframe sandbox="allow-scripts" srcdoc="${srcdoc}"></iframe>`);
      const framed = host.frames()[1];
      await framed.waitForSelector('#panel .step');
      await framed.click('#panel .next');
      const embeddedStep = await framed.evaluate(
        () => document.getElementById('player')!.dataset.step,
      );
      const sources = await auto.evaluate(() =>
        (document.getElementById('frame') as HTMLImageElement).getAttribute('src'),
      );

      assert.deepEqual(
        [start.step, start.playing, start.title, start.dots, start.hash],
        [0, true, 'One', 4, '#1'],
        'opens on the first step, playing, a dot a step',
      );
      assert.deepEqual(
        [waited.step, waited.playing],
        [0, false],
        'a step plays, then waits for the viewer',
      );
      assert.deepEqual(
        [second.step, second.title, second.notes, second.hash],
        [1, 'Two', 'n2', '#2'],
        '→: the next, its notes',
      );
      assert.deepEqual([last.step, home.step], [3, 0], 'End and Home');
      assert.deepEqual(
        [third.step, third.title, third.caption],
        [2, 'Three', 'Hello'],
        "a dot: that step, its tour's caption in the panel",
      );
      assert.deepEqual(
        [deep.step, deep.title, deep.notes],
        [3, 'Four', 'n4'],
        'a link to #4 opens there',
      );
      assert.deepEqual([still.step, still.playing], [2, false], 'reduced motion: still');
      assert.equal(still.frame, lastOfThree, "and on its step's last frame");
      assert.deepEqual(
        [looped.playing, paused.playing, resumed.playing],
        [true, false, true],
        'K pauses and plays',
      );
      assert.true(
        seen.has(3) && looped.step === 0,
        `auto plays through every step and loops (${[...seen]})`,
      );
      assert.true(
        assets.length > 1 && assets.every((file) => file.endsWith('.jpg')),
        'files: pictures beside it',
      );
      assert.true(sources!.startsWith('auto-files/frame-'), 'and the page reads them from there');
      assert.equal(embeddedStep, '1', 'it steps on in a sandboxed frame');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close().catch(() => {});
      permit.release();
    }
  });

  test('a recording of steps prints as one PDF, a page a step, slides as text where the engine prints', async (assert, testMetadata) => {
    await using dir = await tempDir('record-deck-pdf');
    await writeDeck(dir.path);
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    const vector = BROWSER === 'chromium';
    const [fit, paper] = await Promise.all([
      shell(
        `node ${CLI} record deck.md photo.png app.tour.ts -w 320 -h 200 -f deck.pdf --output=${dir.path}`,
        metadata,
      ),
      shell(
        `node ${CLI} record deck.md photo.png app.tour.ts -w 320 -h 200 -f a4.pdf --pdf-paper=A4 --pdf-landscape --pdf-margin=10mm --panel=above --output=${dir.path}`,
        metadata,
      ),
    ]);
    const deck = parsePdf(await fs.readFile(path.join(dir.path, 'deck.pdf')));
    const a4 = parsePdf(await fs.readFile(path.join(dir.path, 'a4.pdf')));
    const panel = DEFAULT_PANEL_HEIGHT;

    assert.includes(fit.stdout, '5 pages', 'two slides, a picture and two tour steps');
    assert.deepEqual(
      deck.pages.map(([, , width, height]) => [
        Math.round(width / 0.75),
        Math.round(height / 0.75),
      ]),
      Array(5).fill([320, 200 + panel]),
      'each page exactly a step and its panel, below by default',
    );
    assert.equal(deck.title, 'Recording');
    // Chromium stores an identical picture once: the tour's two steps end on the same frame.
    assert.true(
      vector ? deck.fonts && deck.jpegs >= 1 : !deck.fonts && deck.jpegs === 5,
      vector
        ? `slides kept as text, the tour's steps as pictures (${deck.jpegs})`
        : `every step pictured (${deck.jpegs})`,
    );
    assert.includes(paper.stdout, '5 pages', 'on paper, still one step a page');
    assert.true(
      a4.pages.every(
        ([, , width, height]) => Math.abs(width - 841.9) < 1 && Math.abs(height - 595.3) < 1.5,
      ),
      `A4, sideways (${a4.pages})`,
    );
  });

  test('a recording of steps as .webm is the GIF in motion: the same canvas, panel and length', async (assert, testMetadata) => {
    await using dir = await tempDir('record-deck-video');
    await writeDeck(dir.path);

    const result = await shell(
      `node ${CLI} record deck.md photo.png -w 320 -h 200 --panel=below -f deck.gif,deck.webm --output=${dir.path}`,
      { ...moduleMetadata, ...testMetadata, cwd: dir.path },
    );
    const gif = decodeGif(await fs.readFile(path.join(dir.path, 'deck.gif')));
    const webm = parseWebM(await fs.readFile(path.join(dir.path, 'deck.webm')));
    const gifMs = gif.frames.reduce((sum, frame) => sum + frame.delayMs, 0);

    assert.includes(result.stdout, `deck.webm  320×${200 + DEFAULT_PANEL_HEIGHT}`);
    assert.deepEqual(
      [webm.width, webm.height],
      [gif.width, gif.height],
      'the canvas and its panel',
    );
    assert.equal(webm.codecId, 'V_VP9');
    assert.true(webm.blocks.length >= 3, `a frame per step at least (${webm.blocks.length})`);
    assert.true(
      Math.abs(webm.durationMs - gifMs) <= 100,
      `as long as the GIF (${webm.durationMs}ms, ${gifMs}ms)`,
    );
  });

  test('a recording of steps is a PowerPoint deck and a Word document: a slide, and a section, a step', async (assert, testMetadata) => {
    await using dir = await tempDir('record-deck-office');
    await writeDeck(dir.path);
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    const result = await shell(
      `node ${CLI} record deck.md photo.png app.tour.ts -w 320 -h 200 -f deck.pptx,deck.docx --pdf-paper=Letter --output=${dir.path}`,
      metadata,
    );
    const read = async (name: string) =>
      new Map(
        unzip(await fs.readFile(path.join(dir.path, name))).map((entry) => [
          entry.name,
          new TextDecoder().decode(entry.bytes),
        ]),
      );
    const [pptx, docx] = await Promise.all([read('deck.pptx'), read('deck.docx')]);
    const slides = [...pptx.keys()]
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort();
    const titles = slides.map(
      (name) => /<p:ph type="title"\/>[^]*?<a:t>([^<]*)<\/a:t>/.exec(pptx.get(name)!)?.[1],
    );
    const document = docx.get('word/document.xml')!;

    assert.includes(result.stdout, 'deck.pptx  320×296  5 slides');
    assert.includes(result.stdout, 'deck.docx');
    assert.includes(result.stdout, '5 steps');
    assert.deepEqual(
      titles,
      ['One', 'Two', 'photo', 'Three', 'Four'],
      'every step a slide, in order, titled',
    );
    assert.includes(
      pptx.get('ppt/notesSlides/notesSlide2.xml')!,
      '<a:t>n2</a:t>',
      "a slide's notes, as speaker notes",
    );
    assert.includes(
      pptx.get('ppt/slides/slide4.xml')!,
      '<a:t>Hello</a:t>',
      "the tour's caption, in the panel",
    );
    assert.equal(
      [...pptx.keys()].filter((name) => name.startsWith('ppt/media/')).length,
      5,
      'a picture a slide',
    );
    assert.deepEqual(
      [
        ...document.matchAll(
          /<w:pStyle w:val="Heading1"\/><w:keepNext\/><\/w:pPr><w:r><w:t xml:space="preserve">([^<]*)</g,
        ),
      ].map((match) => match[1]),
      ['One', 'Two', 'photo', 'Three', 'Four'],
      'a heading a step',
    );
    assert.includes(
      document,
      '<w:pgSz w:w="12240" w:h="15840"/>',
      'on Letter, as --pdf-paper asks',
    );
  });

  test('a bad flag, a missing stylesheet, a deck of no slides and CSS the browser refuses fail by name', async (assert, testMetadata) => {
    await using dir = await tempDir('record-deck-refusals');
    await fs.writeFile(path.join(dir.path, 'empty.md'), '---\n\n---\n');
    await fs.writeFile(path.join(dir.path, 'deck.md'), '# One\n');
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    const [panel, css, empty] = await Promise.all([
      shellFails(`node ${CLI} record deck.md --panel=left --output=${dir.path}`, metadata),
      shellFails(`node ${CLI} record deck.md --css=nope.css --output=${dir.path}`, metadata),
      shellFails(`node ${CLI} record empty.md -f empty.gif --output=${dir.path}`, metadata),
    ]);
    const permit = await acquireBrowser();
    const style = await QUnitX.record('deck.md', {
      cwd: dir.path,
      output: dir.path,
      browser: BROWSER,
      formats: ['gif'],
      slide: { style: { colr: 'red' } },
    })
      .result()
      .finally(() => permit.release());

    assert.includes(panel.stderr, "placement: expected 'above' or 'below', got \"left\"");
    assert.includes(css.stderr, '--css nope.css: no such file');
    assert.includes(empty.stderr, 'cannot record empty.md: it has no slides');
    assert.includes(
      (style as Error).message,
      'record option slide.style: colr is not a CSS property',
    );
  });
});
