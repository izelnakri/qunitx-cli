import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import * as PNG from '../../lib/record/png.ts';
import { execute as shell, shellFails } from '../helpers/shell.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import { decodeGif } from '../helpers/gif-decode.ts';
import { parsePdf } from '../helpers/pdf-parse.ts';
import '../helpers/custom-asserts.ts';

// `qunitx record`, through the real binary, against pages and scripts written into a temp dir.
// Pages are flat colors so a pixel read back says which page — and which state of it — was shot.

const CLI = path.resolve('cli.ts');
const BROWSER = process.env.QUNITX_BROWSER || 'chromium';

const page = (background: string, body = '') =>
  `<!doctype html><html><head><style>html,body{margin:0;background:${background}}</style></head><body>${body}</body></html>`;

// The `[r, g, b]` at `(x, y)`.
function pixel(image: PNG.Image, x: number, y: number): number[] {
  const offset = (y * image.width + x) * 4;
  return [...image.data.subarray(offset, offset + 3)];
}

// Within a step of `expected` on every channel: browsers color-manage, and JPEG is lossy.
function near(actual: number[], expected: number[], tolerance = 3): boolean {
  return actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
}

async function png(file: string): Promise<PNG.Image> {
  return PNG.decode(await fs.readFile(file));
}

module('Commands | record | pages', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('an .html page is served from its own directory, sized by -w and -h', async (assert, testMetadata) => {
    await using dir = await tempDir('record-page');
    await fs.writeFile(
      path.join(dir.path, 'styles.css'),
      'html,body{margin:0;background:rgb(0,128,255)}',
    );
    await fs.writeFile(
      path.join(dir.path, 'home.html'),
      '<!doctype html><link rel="stylesheet" href="styles.css"><h1>home</h1>',
    );

    const result = await shell(
      `node ${CLI} record home.html -f png -w 320 -h 200 --output=${dir.path}`,
      { ...moduleMetadata, ...testMetadata, cwd: dir.path },
    );
    const shot = await png(path.join(dir.path, 'home.png'));

    assert.includes(result.stdout, 'home.png  320×200');
    assert.deepEqual([shot.width, shot.height], [320, 200]);
    assert.true(near(pixel(shot, 300, 190), [0, 128, 255]), 'the relative stylesheet loaded');
  });

  test('two inputs make a still of each and one GIF of both, in order', async (assert, testMetadata) => {
    await using dir = await tempDir('record-two');
    await fs.writeFile(path.join(dir.path, 'red.html'), page('rgb(255,0,0)'));
    await fs.mkdir(path.join(dir.path, 'blue'));
    await fs.writeFile(path.join(dir.path, 'blue', 'index.html'), page('rgb(0,0,255)'));

    const result = await shell(
      `node ${CLI} record red.html blue -w 64 -h 48 --last-frame-duration=700 --output=${dir.path}`,
      { ...moduleMetadata, ...testMetadata, cwd: dir.path },
    );
    const gif = decodeGif(await fs.readFile(path.join(dir.path, 'recording.gif')));

    assert.deepEqual(
      result.stdout
        .trim()
        .split('\n')
        .map((line) => line.split('  ')[0]),
      ['red.jpg', 'blue.jpg', 'recording.gif'],
    );
    assert.deepEqual(
      gif.frames.map((frame) => frame.delayMs),
      [700, 700],
    );
    assert.deepEqual([...gif.frames[0].rgba.subarray(0, 3)], [255, 0, 0]);
    assert.deepEqual([...gif.frames[1].rgba.subarray(0, 3)], [0, 0, 255]);
  });

  test('-f takes file names, comma-separated, a space after the comma included', async (assert, testMetadata) => {
    await using dir = await tempDir('record-names');
    await fs.writeFile(path.join(dir.path, 'a.html'), page('rgb(0,160,0)'));

    await shell(
      `node ${CLI} record a.html -f some-name.gif, shots/some-name.jpg -w 40 -h 30 --output=${dir.path}`,
      { ...moduleMetadata, ...testMetadata, cwd: dir.path },
    );
    const jpeg = await fs.readFile(path.join(dir.path, 'shots', 'some-name.jpg'));
    const gif = decodeGif(await fs.readFile(path.join(dir.path, 'some-name.gif')));

    assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'a JPEG');
    assert.deepEqual([gif.width, gif.height, gif.frames.length], [40, 30, 1]);
    assert.deepEqual(
      (await fs.readdir(dir.path)).sort(),
      ['a.html', 'shots', 'some-name.gif'],
      'nothing else written',
    );
  });

  test('a URL is loaded as it is, and named after its host and path', async (assert, testMetadata) => {
    await using dir = await tempDir('record-url');
    await using server = await listen((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(page('rgb(255,255,0)'));
    });

    await shell(
      `node ${CLI} record http://127.0.0.1:${server.port}/docs/ -f png -w 50 -h 50 --output=${dir.path}`,
      {
        ...moduleMetadata,
        ...testMetadata,
      },
    );
    const shot = await png(path.join(dir.path, `127.0.0.1-${server.port}-docs.png`));

    assert.true(near(pixel(shot, 25, 25), [255, 255, 0]));
  });

  test('--full-page takes the whole page, --scale multiplies the pixels, --wait-for waits for a selector', async (assert, testMetadata) => {
    await using dir = await tempDir('record-options');
    await fs.writeFile(
      path.join(dir.path, 'tall.html'),
      page(
        'rgb(255,255,255)',
        `<div style="height:900px"></div><script>setTimeout(() => {
          document.body.style.background = 'rgb(0,0,0)';
          document.body.append(Object.assign(document.createElement('p'), { id: 'ready' }));
        }, 300)</script>`,
      ),
    );

    await shell(
      `node ${CLI} record tall.html -f png -w 100 -h 100 --scale=2 --full-page --wait-for #ready --output=${dir.path}`,
      { ...moduleMetadata, ...testMetadata, cwd: dir.path },
    );
    const shot = await png(path.join(dir.path, 'tall.png'));

    assert.equal(shot.width, 200, '100 CSS pixels at scale 2');
    assert.true(shot.height >= 1800, `the whole 900px page at scale 2 (got ${shot.height})`);
    assert.true(near(pixel(shot, 10, 10), [0, 0, 0]), 'shot after #ready appeared, not before');
  });
});

module('Commands | record | animation', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('--page-duration records a page for that long instead of taking one still', async (assert, testMetadata) => {
    await using dir = await tempDir('record-duration');
    await fs.writeFile(
      path.join(dir.path, 'blink.html'),
      page(
        'rgb(0,0,0)',
        `<script>setTimeout(() => {
          document.documentElement.style.background = 'rgb(255,255,255)';
        }, 1200)</script>`,
      ),
    );

    await shell(
      `node ${CLI} record blink.html -f gif --page-duration=2500 -w 40 -h 40 --output=${dir.path}`,
      { ...moduleMetadata, ...testMetadata, cwd: dir.path },
    );
    const gif = decodeGif(await fs.readFile(path.join(dir.path, 'blink.gif')));
    const shades = new Set(gif.frames.map((frame) => frame.rgba[0]));

    // One change, well inside the window: frames are sampled, so a fast blink could fall between two
    // on a slow machine, but a page that turns white halfway through cannot.
    assert.true(gif.frames.length >= 2, `more than one frame (${gif.frames.length})`);
    assert.equal(gif.frames[0].rgba[0], 0, 'it opens on the page as it loaded');
    assert.equal(gif.frames.at(-1)!.rgba[0], 255, 'and ends on how it changed');
    assert.deepEqual(
      [...shades].sort((a, b) => a - b),
      [0, 255],
    );
  });
});

module('Commands | record | scripts', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('a script is recorded while it runs: a GIF of each step, and a still of where it ended', async (assert, testMetadata) => {
    await using dir = await tempDir('record-script');
    await fs.writeFile(
      path.join(dir.path, 'steps.ts'),
      `const colors: string[] = ['rgb(255,0,0)', 'rgb(0,255,0)', 'rgb(0,0,255)'];
      document.documentElement.style.cssText = 'margin:0;height:100%';
      document.body.style.cssText = 'margin:0;height:100%';
      for (const color of colors) {
        document.body.style.background = color;
        // Frames are sampled; this puts each step in the recording whatever the machine's speed.
        await (globalThis as { qunitxRecordFrame?: () => Promise<void> }).qunitxRecordFrame?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      console.log('painted', colors.length);`,
    );

    const result = await shell(`node ${CLI} record steps.ts -w 480 -h 200 --output=${dir.path}`, {
      ...moduleMetadata,
      ...testMetadata,
      cwd: dir.path,
    });
    const gif = decodeGif(await fs.readFile(path.join(dir.path, 'steps.gif')));
    const colors = gif.frames.map((frame) =>
      [...frame.rgba.subarray(4 * 30, 4 * 30 + 3)].join(','),
    );

    assert.includes(result.stdout, 'painted 3', "the script's own console still comes through");
    assert.includes(result.stdout, 'steps.jpg  480×200');
    for (const color of ['255,0,0', '0,255,0', '0,0,255']) {
      assert.true(colors.includes(color), `a frame shows ${color} (frames: ${colors.join(' | ')})`);
    }
    assert.equal(colors.at(-1), '0,0,255', 'and it ends where the script did');
    const held = gif.frames.at(-1)!.delayMs;
    assert.true(
      held >= 1000,
      `the last frame stays for --last-frame-duration on top of its own time (${held}ms)`,
    );
  });

  test('a script that fails still has its files written, and the run exits 1', async (assert, testMetadata) => {
    await using dir = await tempDir('record-script-fails');
    await fs.writeFile(
      path.join(dir.path, 'broken.js'),
      `document.body.style.background = 'rgb(0,0,0)'; globalThis.exitCode = 3;`,
    );

    const result = await shellFails(
      `node ${CLI} record broken.js -f png -w 20 -h 20 --output=${dir.path}`,
      {
        ...moduleMetadata,
        ...testMetadata,
        cwd: dir.path,
      },
    );

    assert.exitCode(result, 1);
    assert.includes(result.stderr, '# broken.js exited 3');
    assert.true(near(pixel(await png(path.join(dir.path, 'broken.png')), 5, 5), [0, 0, 0]));
  });
});

module('Commands | record | arguments', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('--help exits 0 with the usage; a bad flag exits 2 with it; no input exits 2', async (assert, testMetadata) => {
    const metadata = { ...moduleMetadata, ...testMetadata };
    const [help, badFlag, noInput] = await Promise.all([
      shell(`node ${CLI} record --help`, metadata),
      shellFails(`node ${CLI} record page.html -w wide`, metadata),
      shellFails(`node ${CLI} record`, metadata),
    ]);

    assert.includes(help.stdout, 'Usage: qunitx record');
    assert.exitCode(badFlag, 2);
    assert.includes(badFlag.stderr, 'qunitx record -w: expected a whole number of pixels');
    assert.exitCode(noInput, 2);
    assert.includes(noInput.stderr, 'needs at least one URL, page or script');
  });

  test('an input that is not there exits 1 naming it, before any browser starts', async (assert, testMetadata) => {
    await using dir = await tempDir('record-missing');
    const result = await shellFails(`node ${CLI} record nope.html --output=${dir.path}`, {
      ...moduleMetadata,
      ...testMetadata,
      cwd: dir.path,
    });

    assert.exitCode(result, 1);
    assert.includes(result.stderr, 'cannot record nope.html: no such file or directory');
    assert.deepEqual(await fs.readdir(dir.path), [], 'nothing written');
  });

  test('a page that cannot load exits 1 with the browser’s reason', async (assert, testMetadata) => {
    // A server that hangs up on every request, rather than a port closed after use: the suite runs
    // in parallel, and a freed port can be bound by another test before the browser reaches it.
    await using server = await listen((request) => request.socket.destroy());

    const result = await shellFails(
      `node ${CLI} record http://127.0.0.1:${server.port}/ -f png --timeout=10000`,
      { ...moduleMetadata, ...testMetadata },
    );

    assert.exitCode(result, 1);
    assert.includes(result.stderr, `127.0.0.1:${server.port}`, 'naming the page');
    if (BROWSER === 'chromium') assert.regex(result.stderr, /net::ERR_/, "and Chromium's reason");
  });
});

// A throwaway HTTP server on a free port, closed when the scope ends.
async function listen(
  handler: http.RequestListener,
): Promise<{ port: number; [Symbol.asyncDispose](): Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as { port: number }).port,
    [Symbol.asyncDispose]: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

module('Commands | record | pdf', { concurrency: true }, (_hooks, moduleMetadata) => {
  // A page whose print styles drop its tall middle: a print-media PDF is shorter than a screen one.
  const DOCUMENT = `<!doctype html><title>Invoice 42</title>
    <style>body{margin:0;font:16px sans-serif} .tall{height:1600px;background:#e7f5ff} @media print{.tall{display:none}}</style>
    <h1>Invoice 42</h1><p>Total $420</p><div class="tall"></div><p>End</p>`;
  const vector = BROWSER === 'chromium';

  test('a page prints to a PDF: fit by default, or on paper, sideways, with margins and its print styles', async (assert, testMetadata) => {
    await using dir = await tempDir('record-pdf');
    await fs.writeFile(path.join(dir.path, 'doc.html'), DOCUMENT);
    // No doctype: quirks mode, where Firefox measures a short page by its content alone.
    await fs.writeFile(
      path.join(dir.path, 'short.html'),
      '<body style="margin:0"><button>Buy</button>',
    );
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    const run = (flags: string, page = 'doc.html') =>
      shell(`node ${CLI} record ${page} -w 600 -h 400 ${flags} --output=${dir.path}`, metadata);
    const [fit, screen, print, raster, short] = await Promise.all([
      run('-f fit.pdf'),
      run('-f screen.pdf --pdf-paper=A4 --pdf-landscape --pdf-margin=10mm'),
      run('-f print.pdf --pdf-paper=A4 --pdf-landscape --pdf-margin=10mm --pdf-media=print'),
      run('-f raster.pdf --pdf-mode=raster --pdf-paper=A5'),
      run('-f short.pdf', 'short.html'),
    ]);
    const read = async (name: string) => parsePdf(await fs.readFile(path.join(dir.path, name)));
    const [fitPdf, screenPdf, printPdf, rasterPdf] = await Promise.all(
      ['fit.pdf', 'screen.pdf', 'print.pdf', 'raster.pdf'].map(read),
    );

    assert.equal(fitPdf.pages.length, 1, 'fit: one page');
    assert.true(
      Math.abs(fitPdf.pages[0][2] - 600 * 0.75) < 2 && fitPdf.pages[0][3] > 1600 * 0.75,
      `the page's own size, in points (${fitPdf.pages[0]})`,
    );
    assert.equal(fitPdf.title, 'Invoice 42', "the page's title");
    assert.deepEqual(
      [fitPdf.fonts, fitPdf.jpegs > 0],
      vector ? [true, false] : [false, true],
      vector ? 'chromium prints text as text' : 'this engine cannot print: screenshots on pages',
    );
    assert.true(
      screenPdf.pages.every(
        ([, , width, height]) => Math.abs(width - 841.9) < 1 && Math.abs(height - 595.3) < 1.5,
      ),
      `A4, sideways, every page (${screenPdf.pages})`,
    );
    assert.true(printPdf.pages.length < screenPdf.pages.length, 'its print styles, honored');
    assert.deepEqual(
      [rasterPdf.fonts, rasterPdf.jpegs, rasterPdf.xrefValid],
      [false, rasterPdf.pages.length, true],
      'raster, asked for: a picture a page',
    );
    assert.includes(fit.stdout, 'fit.pdf  600×');
    assert.includes(fit.stdout, '1 page');
    assert.includes(raster.stdout, 'raster.pdf  559×794');
    assert.includes(
      short.stdout,
      'short.pdf  600×400  1 page',
      'a short page fits the window it is shown in',
    );
    assert.exitCode(screen, 0);
    assert.exitCode(print, 0);
  });

  test('a header, a footer, page ranges and an outline in chromium; asked of an engine that cannot print, refused', async (assert, testMetadata) => {
    await using dir = await tempDir('record-pdf-vector');
    await fs.writeFile(path.join(dir.path, 'doc.html'), DOCUMENT);
    await fs.writeFile(
      path.join(dir.path, 'footer.html'),
      '<div style="font-size:8px"><span class="pageNumber"></span></div>',
    );
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    const command = `node ${CLI} record doc.html -f doc.pdf --pdf-paper=A5 --pdf-margin=15mm --pdf-footer=footer.html --pdf-pages=1 --pdf-outline --output=${dir.path}`;
    if (!vector) {
      const refused = await shellFails(command, metadata);
      assert.includes(
        refused.stderr,
        'record option pdf: footer needs vector mode, which needs chromium',
      );
      return;
    }
    const [result, missing] = await Promise.all([
      shell(command, metadata),
      shellFails(
        `node ${CLI} record doc.html -f x.pdf --pdf-header=nope.html --output=${dir.path}`,
        metadata,
      ),
    ]);
    const pdf = parsePdf(await fs.readFile(path.join(dir.path, 'doc.pdf')));

    assert.equal(pdf.pages.length, 1, 'only the page asked for');
    assert.includes(result.stdout, '1 page');
    assert.includes(missing.stderr, '--pdf-header nope.html: no such file');
  });
});
