import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import { decodeGif } from '../helpers/gif-decode.ts';
import { parseMp4, parseWebM } from '../helpers/video-parse.ts';
import { parsePdf } from '../helpers/pdf-parse.ts';
import * as PNG from '../../lib/record/png.ts';
import * as QUnitX from '../../lib/api/index.ts';
import type { RecordOptions, RecordResult } from '../../lib/api/index.ts';
import '../helpers/custom-asserts.ts';

// The JS API twin of test/commands/record-test.ts: every option the command line has, given as
// data, and every outcome read back off the result rather than off stdout. The browser is the
// lane's (QUNITX_BROWSER), as `qunitx record` itself would pick.
const browser = (process.env.QUNITX_BROWSER || undefined) as RecordOptions['browser'];

async function recorded(inputs: string | string[], options: RecordOptions): Promise<RecordResult> {
  const permit = await acquireBrowser();
  try {
    return await QUnitX.record(inputs, { browser, ...options });
  } finally {
    permit.release();
  }
}

const PAGE = `<!doctype html><body style="margin:0;background:rgb(0,128,255)">
  <div id="late" style="height:2000px"></div>
  <script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p id="ready">ready</p>'), 300)</script>`;

module('API | record | stills and options', { concurrency: true }, () => {
  test('a page becomes the files asked for, at the size asked for, in that order', async (assert) => {
    await using dir = await tempDir('api-record-stills');
    await fs.writeFile(path.join(dir.path, 'page.html'), PAGE);
    const result = await recorded('page.html', {
      cwd: dir.path,
      output: 'shots',
      formats: ['home.png', 'jpg'],
      width: 320,
      height: 200,
      scale: 2,
    });

    assert.true(result.ok);
    assert.deepEqual(
      result.files.map((file) => [
        path.relative(dir.path, file.path),
        file.format,
        file.width,
        file.height,
        file.frames,
      ]),
      [
        [path.join('shots', 'home.png'), 'png', 640, 400, 1],
        [path.join('shots', 'page.jpg'), 'jpeg', 640, 400, 1],
      ],
      'relative to cwd and output, in device pixels, in the order asked',
    );
    for (const file of result.files) {
      assert.equal((await fs.stat(file.path)).size, file.bytes, `${file.format}: bytes as written`);
    }
  });

  test('fullPage, waitFor, quality and the defaults each do what the flag does', async (assert) => {
    await using dir = await tempDir('api-record-options');
    await fs.writeFile(path.join(dir.path, 'page.html'), PAGE);
    const [full, waited, low] = await Promise.all([
      recorded('page.html', {
        cwd: dir.path,
        formats: ['full.png', 'full.jpg'],
        width: 300,
        height: 200,
        fullPage: true,
        // #ready is added late; both stills are taken once it is, so they show the same page.
        waitFor: '#ready',
      }),
      recorded('page.html', {
        cwd: dir.path,
        formats: ['waited.png'],
        width: 300,
        height: 200,
        waitFor: '#ready',
      }),
      recorded('page.html', {
        cwd: dir.path,
        formats: ['low.jpg'],
        width: 300,
        height: 200,
        quality: 5,
      }),
    ]);
    const plain = await recorded('page.html', {
      cwd: dir.path,
      formats: ['plain.jpg'],
      width: 300,
      height: 200,
    });

    assert.true(full.files[0].height >= 2000, `the whole page (${full.files[0].height}px tall)`);
    assert.deepEqual(
      [full.files[1].width, full.files[1].height],
      [full.files[0].width, full.files[0].height],
      "a full-page jpg is as big as the png: its size is read off the file, as the png's is",
    );
    assert.equal(waited.files[0].height, 200, 'waited for, then the viewport');
    assert.true(low.files[0].bytes < plain.files[0].bytes, 'a lower quality is a smaller jpg');
  });

  test('stills of several pages, made side by side, come back in order, each of its own page', async (assert) => {
    await using dir = await tempDir('api-record-side-by-side');
    const colors = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
    ];
    // The first page is the slowest to load, so the pages finish in the reverse of their order.
    await Promise.all(
      colors.map(([r, g, b], index) =>
        fs.writeFile(
          path.join(dir.path, `${index}.html`),
          `<!doctype html><body style="margin:0;background:rgb(${r},${g},${b})"><script>
            for (const end = Date.now() + ${(colors.length - index) * 150}; Date.now() < end; );
          </script>`,
        ),
      ),
    );
    const result = await recorded(
      colors.map((_color, index) => `${index}.html`),
      { cwd: dir.path, formats: ['png'], width: 40, height: 30 },
    );
    const stills = await Promise.all(
      result.files.map(async (file) => PNG.decode(await fs.readFile(file.path))),
    );

    assert.deepEqual(
      result.files.map((file) => path.basename(file.path)),
      ['0.png', '1.png', '2.png', '3.png'],
    );
    // Within a step on each channel: browsers color-manage.
    assert.true(
      stills.every((still, index) =>
        [...still.data.subarray(0, 3)].every(
          (value, channel) => Math.abs(value - colors[index][channel]) <= 3,
        ),
      ),
      'each still is of its own page',
    );
  });

  test('several pages are a GIF too, framed by pageDuration, lastFrameDuration and fps', async (assert) => {
    await using dir = await tempDir('api-record-gif');
    await fs.writeFile(path.join(dir.path, 'a.html'), PAGE);
    await fs.writeFile(
      path.join(dir.path, 'b.html'),
      PAGE.replace('rgb(0,128,255)', 'rgb(255,128,0)'),
    );
    const result = await recorded(['a.html', 'b.html'], {
      cwd: dir.path,
      width: 200,
      height: 120,
      pageDuration: 600,
      fps: 5,
      lastFrameDuration: 400,
    });
    const gif = result.files.find((file) => file.format === 'gif')!;
    const decoded = decodeGif(await fs.readFile(gif.path));

    assert.deepEqual(
      result.files.map((file) => path.basename(file.path)),
      ['a.jpg', 'b.jpg', 'recording.gif'],
      'a still each and one GIF of both, by default',
    );
    assert.equal(gif.frames, decoded.frames.length);
    assert.true(
      decoded.frames.every((frame) => frame.delayMs >= 200),
      'no faster than 5 fps',
    );
  });

  test('webm and mp4 are formats like any other: written, sized, and as long as the recording', async (assert) => {
    await using dir = await tempDir('api-record-video');
    await fs.writeFile(path.join(dir.path, 'a.html'), PAGE);
    await fs.writeFile(
      path.join(dir.path, 'b.html'),
      PAGE.replace('rgb(0,128,255)', 'rgb(255,128,0)'),
    );
    const result = await recorded(['a.html', 'b.html'], {
      cwd: dir.path,
      formats: ['clip.webm', 'clip.mp4'],
      width: 320,
      height: 180,
      lastFrameDuration: 500,
    });
    const [webm, mp4] = result.files;
    const parsedWebm = parseWebM(await fs.readFile(webm.path));
    const parsedMp4 = parseMp4(await fs.readFile(mp4.path));

    assert.deepEqual(
      result.files.map((file) => [path.basename(file.path), file.format, file.width, file.height]),
      [
        ['clip.webm', 'webm', 320, 180],
        ['clip.mp4', 'mp4', 320, 180],
      ],
    );
    assert.deepEqual(
      [parsedWebm.width, parsedWebm.height, parsedMp4.width, parsedMp4.height],
      [320, 180, 320, 180],
    );
    assert.true(
      Math.abs(parsedWebm.durationMs - 1000) < 150 && Math.abs(parsedMp4.durationMs - 1000) < 150,
      `two pages held 500 ms each (${parsedWebm.durationMs}, ${parsedMp4.durationMs} ms)`,
    );
  });

  test("a script's console goes where `console` says, and a failing script is a result", async (assert) => {
    await using dir = await tempDir('api-record-script');
    await fs.writeFile(
      path.join(dir.path, 'draws.ts'),
      "document.body.style.background = 'red'; console.log('drawn'); throw new Error('then broke');",
    );
    const said: string[] = [];
    const console = {
      ...globalThis.console,
      log: (...args: unknown[]) => said.push(args.join(' ')),
    };
    const result = await recorded('draws.ts', {
      cwd: dir.path,
      formats: ['png'],
      width: 200,
      height: 120,
      timeout: 20_000,
      console: console as unknown as RecordOptions['console'],
    });

    assert.false(result.ok, 'not ok');
    assert.deepEqual(
      result.failedScripts.map((script) => path.basename(script.path)),
      ['draws.ts'],
    );
    assert.true(result.failedScripts[0].exitCode !== 0);
    assert.equal(result.files.length, 1, 'its files written all the same');
    assert.true(
      said.some((line) => line.includes('drawn')),
      `its console (${said.join(' | ')})`,
    );
  });
});

module('API | record | pdf', { concurrency: true }, () => {
  test('pdf settings are an object like any option; the result counts its pages', async (assert) => {
    await using dir = await tempDir('api-record-pdf');
    await fs.writeFile(path.join(dir.path, 'page.html'), PAGE);
    const result = await recorded('page.html', {
      cwd: dir.path,
      formats: ['page.pdf'],
      width: 400,
      height: 300,
      pdf: { paper: 'Letter', margin: { top: '1in', bottom: '0.5in' }, background: false },
    });
    const [file] = result.files;
    const pdf = parsePdf(await fs.readFile(file.path));

    assert.deepEqual(
      [file.format, file.width, file.height],
      ['pdf', 816, 1056],
      'Letter, in CSS pixels',
    );
    assert.equal(file.frames, pdf.pages.length, 'frames counts its pages');
    assert.true(pdf.pages.every(([, , width, height]) => width === 612 && height === 792));
  });

  test("a raster PDF without background leaves the page's own background to the stills after it", async (assert) => {
    await using dir = await tempDir('api-record-pdf-background');
    await fs.writeFile(
      path.join(dir.path, 'page.html'),
      '<!doctype html><body style="margin:0;background:rgb(0,128,255)">',
    );
    await recorded('page.html', {
      cwd: dir.path,
      formats: ['page.pdf', 'page.png'],
      width: 40,
      height: 30,
      pdf: { mode: 'raster', background: false },
    });
    const still = PNG.decode(await fs.readFile(path.join(dir.path, 'page.png')));
    const [r, g, b] = still.data.subarray(0, 3);

    assert.true(
      Math.abs(r - 0) <= 3 && Math.abs(g - 128) <= 3 && Math.abs(b - 255) <= 3,
      `the still is blue, not the PDF's white (${[r, g, b]})`,
    );
  });

  test('a setting out of its rule rejects before any browser, naming it', async (assert) => {
    const outcomes = await Promise.all(
      (
        [
          { pdf: { scale: 5 } },
          { pdf: { paper: 'B9' } },
          { pdf: 'A4' },
        ] as unknown as RecordOptions[]
      ).map((options) => QUnitX.record('https://example.com', options).result()),
    );

    assert.deepEqual(
      outcomes.map((outcome) => (outcome as Error).message),
      [
        'record option pdf: scale: expected a number from 0.1 to 2, got 5',
        'record option pdf: paper: expected one of fit, Letter, Legal, Tabloid, Ledger, A0, A1, A2, A3, A4, A5, A6, got "B9"',
        'record option pdf: expected an object of PDF settings, got "A4"',
      ],
    );
  });
});

module('API | record | refusals', { concurrency: true }, () => {
  test('an option outside what the command line accepts rejects, naming it, before any browser', async (assert) => {
    const outcomes = await Promise.all(
      (
        [
          { fps: 0 },
          { width: 1.5 },
          { quality: 101 },
          { scale: 9 },
          { browser: 'netscape' },
          { waitFor: -1 },
          { fullPage: 'yes' },
          { formats: 'png' },
        ] as unknown as RecordOptions[]
      ).map((options) => QUnitX.record('https://example.com', options).result()),
    );

    assert.deepEqual(
      outcomes.map((outcome) => (outcome as { code: string }).code),
      Array(8).fill('InvalidRecordOption'),
    );
    assert.deepEqual(
      outcomes.map((outcome) => (outcome as Error).message),
      [
        'record option fps: expected a whole number from 1 to 50, got 0',
        'record option width: expected a whole number of pixels from 1 to 16384, got 1.5',
        'record option quality: expected a whole number from 0 to 100, got 101',
        'record option scale: expected a number above 0 and up to 4, got 9',
        'record option browser: expected one of chromium, firefox, webkit, got "netscape"',
        'record option waitFor: expected a number of ms or a CSS selector, got -1',
        'record option fullPage: expected true or false, got "yes"',
        'record option formats: expected a list of formats or file names, got "png"',
      ],
    );
  });

  test('a missing input and an unknown format reject with their own failures', async (assert) => {
    await using dir = await tempDir('api-record-refusals');
    await fs.writeFile(path.join(dir.path, 'page.html'), PAGE);
    const [missing, format] = await Promise.all([
      QUnitX.record('nowhere.html', { cwd: dir.path }).result(),
      QUnitX.record('page.html', { cwd: dir.path, formats: ['bmp'] }).result(),
    ]);

    assert.equal((missing as { code: string }).code, 'UnrecordableInput');
    assert.includes((missing as Error).message, 'nowhere.html');
    assert.equal((format as { code: string }).code, 'UnknownFormat');
  });

  test('an output directory that cannot be made rejects before any page is recorded', async (assert) => {
    await using dir = await tempDir('api-record-unwritable');
    await fs.writeFile(path.join(dir.path, 'page.html'), PAGE);
    await fs.writeFile(path.join(dir.path, 'taken'), 'a file, where the output directory would go');
    // Not a failure `result()` returns: the file system's own error, thrown.
    const outcome = await QUnitX.record('page.html', { cwd: dir.path, output: 'taken/shots' }).then(
      () => null,
      (error: { code: string }) => error.code,
    );

    assert.equal(outcome, 'ENOTDIR');
  });
});
