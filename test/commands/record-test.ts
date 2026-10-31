import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as PNG from '../../lib/record/png.ts';
import { LAYOUT } from '../../lib/record/diff.ts';
import { execute as shell, shellFails } from '../helpers/shell.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import { decodeGif } from '../helpers/gif-decode.ts';
import { parseMp4, parseWebM } from '../helpers/video-parse.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CHROME_HEIGHT, framedSize } from '../../lib/record/tour/index.ts';
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

// ffmpeg is the strictest reader there is, and the one that caught Firefox's malformed avcC. It is
// on GitHub's Ubuntu runners and often on a developer's machine; where it is not, the structure
// checks above it still run.
const execFileAsync = promisify(execFile);
const FFMPEG = await execFileAsync('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);

module('Commands | record | video', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('a script recorded as .webm (VP9) and .mp4 (H.264), each frame with its own time', async (assert, testMetadata) => {
    await using dir = await tempDir('record-video');
    await fs.writeFile(
      path.join(dir.path, 'steps.ts'),
      `document.documentElement.style.cssText = 'height:100%';
      for (const color of ['rgb(255,0,0)', 'rgb(0,255,0)', 'rgb(0,0,255)']) {
        document.documentElement.style.background = color;
        await (globalThis as { qunitxRecordFrame?: () => Promise<void> }).qunitxRecordFrame?.();
        await new Promise((resolve) => setTimeout(resolve, 400));
      }`,
    );

    const result = await shell(
      `node ${CLI} record steps.ts -f steps.webm,steps.mp4 -w 321 -h 181 --last-frame-duration=700 --output=${dir.path}`,
      { ...moduleMetadata, ...testMetadata, cwd: dir.path },
    );
    const webmBytes = await fs.readFile(path.join(dir.path, 'steps.webm'));
    const mp4Bytes = await fs.readFile(path.join(dir.path, 'steps.mp4'));
    const webm = parseWebM(webmBytes);
    const mp4 = parseMp4(mp4Bytes);

    assert.includes(result.stdout, 'steps.webm  321×181');
    assert.includes(result.stdout, 'steps.mp4  320×180', 'H.264 crops an odd side to even');
    assert.equal(webm.codecId, 'V_VP9');
    assert.true(webm.blocks.length >= 3, `a frame per color at least (${webm.blocks.length})`);
    assert.true(webm.blocks[0].key, 'opens on a keyframe');
    assert.true(
      webm.blocks.at(-1)!.durationMs! >= 700,
      'the last frame stays for --last-frame-duration',
    );
    assert.true(
      webm.durationMs >= 1500,
      `about the script's length plus the hold (${webm.durationMs}ms)`,
    );
    assert.deepEqual(mp4.topLevel, ['ftyp', 'moov', 'mdat']);
    assert.equal(mp4.sampleDurations.length, mp4.sampleSizes.length);
    assert.true(mp4.sampleDurations.at(-1)! >= 700);
    assert.equal(mp4.syncSamples[0], 1);
    if (FFMPEG) {
      // `-v error` prints what it could not decode to stderr, and exits 0 when it carried on.
      await Promise.all(
        ['steps.webm', 'steps.mp4'].map(async (file) => {
          const { stderr } = await execFileAsync('ffmpeg', [
            '-v',
            'error',
            '-i',
            path.join(dir.path, file),
            '-f',
            'null',
            '-',
          ]);
          assert.equal(stderr, '', `${file} decodes without a single error`);
        }),
      );
    }
  });

  test('pages make a slideshow video, a still that sat unchanged staying one frame', async (assert, testMetadata) => {
    await using dir = await tempDir('record-video-pages');
    await fs.writeFile(path.join(dir.path, 'a.html'), page('rgb(255,0,0)'));
    await fs.writeFile(path.join(dir.path, 'b.html'), page('rgb(0,0,255)'));

    await shell(
      `node ${CLI} record a.html b.html -f mp4 -w 64 -h 48 --last-frame-duration=900 --output=${dir.path}`,
      {
        ...moduleMetadata,
        ...testMetadata,
        cwd: dir.path,
      },
    );
    const mp4 = parseMp4(await fs.readFile(path.join(dir.path, 'recording.mp4')));

    assert.deepEqual(mp4.sampleDurations, [900, 900]);
    assert.equal(mp4.durationMs, 1800);
  });
});

module('Commands | record | visual diff', { concurrency: true }, (_hooks, moduleMetadata) => {
  const cards = (revenue: string) =>
    page(
      'rgb(245,246,250)',
      `<div style="font:28px sans-serif;padding:20px">Revenue <b id="revenue">${revenue}</b></div>
      <div id="clock" style="font:20px monospace;padding:0 20px">${Date.now()}</div>`,
    );

  test('in a terminal each line is colored by what happened: new green, changed red, updated yellow, files to open cyan', async (assert, testMetadata) => {
    await using dir = await tempDir('record-compare-colors');
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    const record = `FORCE_COLOR=1 node ${CLI} record home.html -w 200 -h 100 --mask #clock --output=snapshots --compare`;
    const paint = (code: number, text: string) => `\x1b[${code}m${text}\x1b[39m`;
    const shot = path.join('snapshots', 'home.png');
    await fs.writeFile(path.join(dir.path, 'home.html'), cards('$8.2k'));

    const first = await shell(record, metadata);
    const second = await shell(record, metadata);
    await fs.writeFile(path.join(dir.path, 'home.html'), cards('$12.9k'));
    const third = await shellFails(
      `${record} --report --pr-comment --images-url https://example.com`,
      metadata,
    );
    const fourth = await shell(`${record} --update`, metadata);

    assert.includes(first.stdout, paint(32, `${shot}  200×100  new`));
    assert.includes(second.stdout, `${shot}  200×100  unchanged\n`);
    assert.notIncludes(second.stdout, '\x1b[', 'a snapshot that held keeps the terminal color');
    assert.includes(third.stdout, `\x1b[31m${shot}  200×100  changed: `);
    assert.includes(third.stdout, paint(36, `${path.join('snapshots', 'report.html')}  report`));
    assert.includes(third.stdout, paint(36, `${path.join('snapshots', 'comment.md')}  comment`));
    assert.includes(fourth.stdout, paint(33, `${shot}  200×100  updated`));
  });

  test('first run makes baselines, an unchanged run leaves them, a change exits 1 with a diff, --update accepts', async (assert, testMetadata) => {
    await using dir = await tempDir('record-compare');
    const run = (extra = '') =>
      shellFails(
        `node ${CLI} record home.html -w 300 -h 120 --mask #clock --output=snapshots --compare ${extra}`,
        {
          ...moduleMetadata,
          ...testMetadata,
          cwd: dir.path,
        },
      ).catch((result: { code: number; stdout: string; stderr: string }) => result);
    const pass = (extra = '') =>
      shell(
        `node ${CLI} record home.html -w 300 -h 120 --mask #clock --output=snapshots --compare ${extra}`,
        {
          ...moduleMetadata,
          ...testMetadata,
          cwd: dir.path,
        },
      );
    const snapshots = path.join(dir.path, 'snapshots');
    await fs.writeFile(path.join(dir.path, 'home.html'), cards('$8.2k'));

    const first = await pass();
    const baseline = await fs.readFile(path.join(snapshots, 'home.png'));
    await fs.writeFile(path.join(dir.path, 'home.html'), cards('$8.2k')); // a new clock value, masked
    const second = await pass();
    const afterSecond = await fs.readFile(path.join(snapshots, 'home.png'));
    await fs.writeFile(path.join(dir.path, 'home.html'), cards('$12.9k'));
    const third = await run();
    const afterThird = await fs.readFile(path.join(snapshots, 'home.png'));
    const diff = await png(path.join(snapshots, 'home.diff.png'));
    const fourth = await pass('--update');

    // Shown relative to where the command ran, in the platform's own separators.
    const shot = path.join('snapshots', 'home.png');
    assert.includes(first.stdout, `${shot}  300×120  new`);
    assert.includes(second.stdout, `${shot}  300×120  unchanged`, 'a masked clock is not a change');
    assert.deepEqual(afterSecond, baseline, 'and the baseline is untouched');
    assert.equal(third.code, 1);
    assert.regex(
      third.stdout,
      /home\.png {2}300×120 {2}changed: [\d,]+ pixels \([\d.]+%\) → snapshots[\\/]home\.diff\.png, snapshots[\\/]home\.new\.png/,
    );
    assert.includes(third.stderr, '1 snapshot changed');
    assert.deepEqual(afterThird, baseline, 'a change does not overwrite the baseline');
    // The box's line, counted on each half: the change is boxed on both before and after.
    const boxed = [0, 1].map((side) => {
      let count = 0;
      for (let offset = 0; offset < diff.data.length; offset += 4) {
        const x = (offset / 4) % diff.width;
        const onSide = side === 0 ? x < diff.width / 2 : x >= diff.width / 2;
        const [r, g, b] = diff.data.subarray(offset, offset + 3);
        if (onSide && r === 232 && g === 23 && b === 93) count++;
      }
      return count;
    });
    assert.equal(diff.width, 2 * 300 + 3 * LAYOUT.gap, 'before and after side by side');
    assert.true(
      boxed.every((count) => count > 20),
      `the new figure boxed on both sides (${boxed})`,
    );
    assert.includes(fourth.stdout, `${shot}  300×120  updated`);
    assert.deepEqual(
      (await fs.readdir(snapshots)).sort(),
      ['home.png'],
      'the review files are cleaned up',
    );
  });

  test('--report writes a review page beside the snapshots whose every image is a file there', async (assert, testMetadata) => {
    await using dir = await tempDir('record-report');
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    await fs.writeFile(path.join(dir.path, 'a.html'), page('rgb(255,0,0)'));
    await fs.writeFile(path.join(dir.path, 'b.html'), page('rgb(0,0,255)'));
    await shell(`node ${CLI} record a.html b.html -w 40 -h 30 --output=shots --report`, metadata);
    await fs.writeFile(path.join(dir.path, 'a.html'), page('rgb(0,160,0)'));

    const result = await shellFails(
      `node ${CLI} record a.html b.html -w 40 -h 30 --output=shots --report`,
      metadata,
    );
    const html = await fs.readFile(path.join(dir.path, 'shots', 'report.html'), 'utf8');
    const sources = [...html.matchAll(/src="([^"]+)"/g)].map((match) =>
      decodeURIComponent(match[1]),
    );

    assert.exitCode(result, 1);
    assert.includes(result.stdout, `${path.join('shots', 'report.html')}  report`);
    assert.includes(html, '<h1>1 changed</h1>');
    assert.true(html.indexOf('a.png</h2>') < html.indexOf('b.png</h2>'), 'the changed one first');
    assert.deepEqual([...new Set(sources)].sort(), ['a.diff.png', 'a.new.png', 'a.png', 'b.png']);
    for (const source of sources) await fs.access(path.join(dir.path, 'shots', source));
  });

  test('package.json#qunitx.record configures a bare `qunitx record`, from any folder, down to comment.md', async (assert, testMetadata) => {
    await using dir = await tempDir('record-config');
    const base = 'https://raw.githubusercontent.com/acme/app/visual/pr-1/run-1/';
    const manifest = (record: object) =>
      fs.writeFile(
        path.join(dir.path, 'package.json'),
        JSON.stringify({ name: 'app', qunitx: { record } }),
      );
    await fs.mkdir(path.join(dir.path, 'pages'));
    await fs.mkdir(path.join(dir.path, 'nested', 'deeper'), { recursive: true });
    await fs.writeFile(path.join(dir.path, 'pages', 'a.html'), page('rgb(255,0,0)'));
    await manifest({
      inputs: ['pages/a.html'],
      width: 40,
      height: 30,
      output: 'shots',
      prComment: true,
      imagesUrl: base,
    });
    const metadata = {
      ...moduleMetadata,
      ...testMetadata,
      cwd: path.join(dir.path, 'nested', 'deeper'),
    };

    const first = await shell(`node ${CLI} record`, metadata);
    const quiet = await fs.readFile(path.join(dir.path, 'shots', 'comment.md'), 'utf8');
    await fs.writeFile(path.join(dir.path, 'pages', 'a.html'), page('rgb(0,0,255)'));
    const second = await shellFails(`node ${CLI} record`, metadata);
    const loud = await fs.readFile(path.join(dir.path, 'shots', 'comment.md'), 'utf8');
    await manifest({ inputs: ['pages/a.html'], width: 'wide' });
    const broken = await shellFails(`node ${CLI} record`, metadata);

    assert.includes(
      first.stdout,
      `${path.join('shots', 'a.png')}  40×30  new`,
      'inputs and output relative to package.json',
    );
    assert.includes(quiet, 'No visual changes in this PR, good job');
    assert.exitCode(second, 1);
    assert.includes(loud, '### Visual changes: 1 of 1 snapshot');
    assert.includes(loud, `src="${base}a.diff.png"`);
    assert.exitCode(broken, 2);
    assert.includes(broken.stderr, 'package.json#qunitx.record.width: expected a whole number');
  });

  test('--max-diff tolerates a few pixels; --compare refuses a jpg', async (assert, testMetadata) => {
    await using dir = await tempDir('record-compare-options');
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    await fs.writeFile(path.join(dir.path, 'dot.html'), page('rgb(255,255,255)'));
    await shell(`node ${CLI} record dot.html -w 40 -h 40 --output=. --compare`, metadata);
    await fs.writeFile(
      path.join(dir.path, 'dot.html'),
      page(
        'rgb(255,255,255)',
        '<i style="position:absolute;left:10px;top:10px;width:2px;height:2px;background:#000"></i>',
      ),
    );

    const tolerated = await shell(
      `node ${CLI} record dot.html -w 40 -h 40 --output=. --compare --max-diff=10`,
      metadata,
    );
    const refused = await shellFails(
      `node ${CLI} record dot.html -f jpg --output=. --compare`,
      metadata,
    );

    assert.includes(tolerated.stdout, 'dot.png  40×40  unchanged');
    assert.exitCode(refused, 1);
    assert.includes(refused.stderr, '--compare works on png stills, and dot.jpg is not one');
  });
});

module('Commands | record | tours', { concurrency: true }, (_hooks, moduleMetadata) => {
  // A page whose state shows in its colors: typing "go" turns it red, the button turns it green,
  // and a blue box sits at a known place for the zoom to find.
  const app = `<!doctype html><meta charset="utf-8"><title>App</title>
    <style>html,body{margin:0;height:100%;background:#fff} #box{position:absolute;left:40px;top:40px;width:40px;height:40px;background:#00f}
    #go{position:absolute;left:300px;top:200px;width:120px;height:40px} #field{position:absolute;left:300px;top:100px}</style>
    <input id="field" oninput="if (this.value === 'go') document.body.style.background = 'rgb(255,0,0)'">
    <button id="go" onclick="document.body.style.background = 'rgb(0,160,0)'">Go</button><div id="box"></div>`;
  const serve = () =>
    listen((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        request.url === '/second'
          ? '<!doctype html><title>Second</title><body style="background:#ffeb3b">'
          : app,
      );
    });
  const blue = (rgba: Uint8Array) => {
    let count = 0;
    for (let pixel = 0; pixel < rgba.length; pixel += 4) {
      if (rgba[pixel] < 40 && rgba[pixel + 1] < 40 && rgba[pixel + 2] > 200) count++;
    }
    return count;
  };

  test('a tour types, clicks and zooms in the real page, with the cursor where it moved to', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour');
    await using server = await serve();
    await fs.writeFile(
      path.join(dir.path, 'app.tour.ts'),
      `export default async (tour) => {
        await tour.goto('http://127.0.0.1:${server.port}/');
        await tour.type('#field', 'go');
        await tour.zoom('#box', { scale: 2 });
        await tour.zoomOut();
        await tour.click('#go');
        await tour.hover({ x: 120, y: 240 });
      };`,
    );

    const result = await shell(
      `node ${CLI} record app.tour.ts -w 480 -h 300 -f app.gif,app.png --output=${dir.path}`,
      {
        ...moduleMetadata,
        ...testMetadata,
        cwd: dir.path,
      },
    );
    const gif = decodeGif(await fs.readFile(path.join(dir.path, 'app.gif')));
    const at = (rgba: Uint8Array, x: number, y: number) => [
      ...rgba.subarray((y * 480 + x) * 4, (y * 480 + x) * 4 + 3),
    ];
    const last = gif.frames.at(-1)!.rgba;
    const unzoomed = blue(gif.frames[0].rgba);
    const mostBlue = Math.max(...gif.frames.map((frame) => blue(frame.rgba)));
    // The cursor by its own pixels: anything in the lower left that is not the page's green, where
    // the page itself has nothing else (the box is higher up, the field and button further right).
    let [left, top, right, bottom] = [480, 300, -1, -1];
    for (let y = 120; y < 300; y++) {
      for (let x = 0; x < 260; x++) {
        if (!near(at(last, x, y), [0, 160, 0], 24)) {
          [left, top, right, bottom] = [
            Math.min(left, x),
            Math.min(top, y),
            Math.max(right, x),
            Math.max(bottom, y),
          ];
        }
      }
    }

    assert.includes(result.stdout, 'app.gif  480×300');
    assert.true(
      gif.frames.some((frame) => near(at(frame.rgba, 20, 280), [255, 0, 0])),
      'typing "go" turned it red',
    );
    assert.true(near(at(last, 20, 280), [0, 160, 0]), 'and the click turned it green');
    assert.true(
      mostBlue > unzoomed * 3,
      `the zoom made the box 4× the area (${unzoomed} → ${mostBlue} px)`,
    );
    assert.true(right >= 0, 'the cursor is drawn');
    assert.true(
      left >= 112 && top >= 232 && right < 150 && bottom < 280,
      `drawn where the tour left it, (120, 240): ${left},${top}–${right},${bottom}`,
    );
  });

  test('a second tab adds the browser frame; the same tour comes out the same, frame for frame', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-tabs');
    await using server = await serve();
    await fs.writeFile(
      path.join(dir.path, 'tabs.tour.ts'),
      `export default async (tour) => {
        await tour.goto('http://127.0.0.1:${server.port}/');
        await tour.caption('Two tabs');
        await tour.hover('#go');
        const second = await tour.open('http://127.0.0.1:${server.port}/second');
        await tour.switchTo(tour.tabs[0]);
        if (tour.tabs.length !== 2 || tour.tabs[1] !== second) throw new Error('tabs out of order');
        await tour.switchTo(second);
        await tour.wait(300);
      };`,
    );
    const run = (name: string) =>
      shell(
        `node ${CLI} record tabs.tour.ts -w 400 -h 240 -f ${name}.gif,${name}.png --output=${dir.path}`,
        {
          ...moduleMetadata,
          ...testMetadata,
          cwd: dir.path,
        },
      );

    await run('first');
    await run('second');
    const first = decodeGif(await fs.readFile(path.join(dir.path, 'first.gif')));
    const second = decodeGif(await fs.readFile(path.join(dir.path, 'second.gif')));
    const still = await png(path.join(dir.path, 'first.png'));

    assert.deepEqual(
      [first.width, first.height],
      [400, 240 + CHROME_HEIGHT],
      'page plus browser frame',
    );
    assert.deepEqual([still.width, still.height], [400, 240], 'stills stay the page');
    assert.true(near(pixel(still, 200, 200), [255, 235, 59]), 'the still is the tab it ended on');
    assert.deepEqual(
      second.frames.map((frame) => frame.delayMs),
      first.frames.map((frame) => frame.delayMs),
      'timing comes from the tour, not the machine',
    );
  });

  // A carousel that pointer events drive (touch-action: pan-y, as real carousels do), a dark tap
  // target, and a page long enough to scroll: white at the top, yellow at the bottom.
  const gallery = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gallery</title>
    <style>html,body{margin:0;background:#fff} #carousel{height:150px;overflow:hidden;touch-action:pan-y;background:#ddd}
    #track{display:flex;height:100%;transition:none} .slide{flex:0 0 100%} #tap{display:block;margin:40px auto;width:160px;height:60px;background:#1d2433;border:0}
    #bottom{height:400px;background:#ffd400}</style>
    <div id="carousel"><div id="track"><div class="slide" style="background:#e03131"></div><div class="slide" style="background:#7048e8"></div></div></div>
    <button id="tap" aria-label="tap"></button><div style="height:1400px"></div><div id="bottom"></div>
    <script>
      const carousel = document.getElementById('carousel'), track = document.getElementById('track');
      let from = null;
      carousel.addEventListener('pointerdown', (event) => { from = event.clientX; });
      carousel.addEventListener('pointermove', (event) => { if (from !== null) track.style.transform = 'translateX(' + Math.min(0, event.clientX - from) + 'px)'; });
      carousel.addEventListener('pointerup', (event) => {
        track.style.transform = event.clientX - from < -50 ? 'translateX(-100%)' : 'translateX(0)';
        from = null;
      });
      document.getElementById('tap').addEventListener('pointerdown', (event) => {
        document.body.dataset.pointer = event.pointerType;
      });
      document.getElementById('tap').addEventListener('click', () => {
        document.getElementById('tap').style.background = document.body.dataset.pointer === 'touch' ? 'rgb(0,160,0)' : 'rgb(255,0,0)';
      });
    </script>`;
  const serveGallery = () =>
    listen((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(gallery);
    });
  const frameAt = (gif: ReturnType<typeof decodeGif>, rgba: Uint8Array, x: number, y: number) => [
    ...rgba.subarray((y * gif.width + x) * 4, (y * gif.width + x) * 4 + 3),
  ];

  test('a desktop tour scrolls down and back up, and swipes a carousel with the mouse', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-scroll');
    await using server = await serveGallery();
    // A tour by what it exports, with no .tour in its name.
    await fs.writeFile(
      path.join(dir.path, 'scroll.ts'),
      `import { tour } from '${pathToFileURL(path.resolve('lib/api/index.ts')).href}';

      export default tour(async (t) => {
        await t.goto('http://127.0.0.1:${server.port}/');
        await t.swipe('#carousel', 'left');
        await t.scroll({ y: 1500 });
        await t.scroll({ y: -1500 });
      });`,
    );

    await shell(`node ${CLI} record scroll.ts -w 390 -h 600 -f scroll.gif --output=${dir.path}`, {
      ...moduleMetadata,
      ...testMetadata,
      cwd: dir.path,
    });
    const gif = decodeGif(await fs.readFile(path.join(dir.path, 'scroll.gif')));
    const yellowAt = gif.frames.findIndex((frame) =>
      near(frameAt(gif, frame.rgba, 200, 450), [255, 212, 0]),
    );
    const last = gif.frames.at(-1)!.rgba;

    assert.deepEqual([gif.width, gif.height], [390, 600], 'no frame for one desktop tab');
    assert.true(
      near(frameAt(gif, last, 200, 70), [112, 72, 232]),
      'the mouse swipe moved the carousel to its second slide',
    );
    assert.true(yellowAt > 0, 'scrolled down to the yellow bottom');
    assert.true(
      near(frameAt(gif, last, 200, 70), [112, 72, 232]) &&
        !near(frameAt(gif, last, 200, 450), [255, 212, 0]),
      'and back up to the top',
    );
  });

  test('a touch tour taps, swipes and scrolls with a finger, inside a phone', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-touch');
    await using server = await serveGallery();
    await fs.writeFile(
      path.join(dir.path, 'phone.tour.ts'),
      `export default { options: { touch: true }, run: async (tour) => {
        await tour.goto('http://127.0.0.1:${server.port}/');
        await tour.tap('#tap');
        await tour.swipe('#carousel', 'left');
        await tour.scroll({ y: 1500 });
        await tour.scroll({ y: -1500 });
      } };`,
    );

    await shell(
      `node ${CLI} record phone.tour.ts -w 390 -h 600 -f phone.gif --output=${dir.path}`,
      {
        ...moduleMetadata,
        ...testMetadata,
        cwd: dir.path,
      },
    );
    const gif = decodeGif(await fs.readFile(path.join(dir.path, 'phone.gif')));
    const size = framedSize('phone', { width: 390, height: 600 });
    // The page's top-left corner inside the phone: past the backdrop, the bezel and the address bar.
    const inset = { x: (size.width - 390) / 2, y: size.height - 600 - (size.width - 390) / 2 };
    const page = (rgba: Uint8Array, x: number, y: number) =>
      frameAt(gif, rgba, inset.x + x, inset.y + y);
    const last = gif.frames.at(-1)!.rgba;
    // The fingertip's white ring over the dark tap target (centred at x 195, y 220).
    const ring = (rgba: Uint8Array) => {
      let white = 0;
      for (let y = 190; y < 250; y++) {
        for (let x = 165; x < 225; x++)
          if (frameAt(gif, rgba, inset.x + x, inset.y + y).every((value) => value > 235)) white++;
      }
      return white;
    };

    assert.deepEqual([gif.width, gif.height], [size.width, size.height], 'drawn inside a phone');
    assert.true(near(frameAt(gif, last, 2, 2), [232, 235, 240]), 'the backdrop around the phone');
    assert.true(
      near(page(last, 195, 220), [0, 160, 0]),
      'the tap arrived as a touch (pointerType "touch")',
    );
    assert.true(
      gif.frames.some((frame) => ring(frame.rgba) > 30),
      'the fingertip shows while it touches',
    );
    assert.equal(ring(last), 0, 'and is gone once it lifts');
    assert.true(near(page(last, 200, 70), [112, 72, 232]), 'the finger swipe moved the carousel');
    assert.false(
      gif.frames.some(
        (frame) =>
          count(gif, frame.rgba, [inset.x, inset.y, inset.x + 40, inset.y + 40], (rgb) =>
            rgb.every((value) => value < 60),
          ) > 0,
      ),
      'no mouse arrow anywhere on a touch tour',
    );
    assert.true(
      gif.frames.some((frame) => near(page(frame.rgba, 200, 450), [255, 212, 0])),
      'scrolled down',
    );
    assert.false(near(page(last, 200, 450), [255, 212, 0]), 'and back up');
  });

  test('hover() on a touch tour is refused with the reason', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-hover');
    await using server = await serveGallery();
    await fs.writeFile(
      path.join(dir.path, 'hover.tour.ts'),
      `export default { options: { touch: true }, run: async (tour) => {
        await tour.goto('http://127.0.0.1:${server.port}/');
        await tour.hover('#tap');
      } };`,
    );

    const result = await shellFails(
      `node ${CLI} record hover.tour.ts -w 390 -h 600 --output=${dir.path}`,
      {
        ...moduleMetadata,
        ...testMetadata,
        cwd: dir.path,
      },
    );

    assert.exitCode(result, 1);
    assert.includes(
      result.stderr,
      'hover() has no meaning on a touch screen: tap, swipe or scroll instead',
    );
  });

  // Right-click shows the page's own menu (orange); a press held past 500 ms turns #hold purple; two
  // pointers spreading apart over #zoom turn it green. All page logic, as an app would have it.
  const gestures = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gestures</title>
    <style>html,body{margin:0;background:#fff} #hold{position:absolute;left:40px;top:40px;width:140px;height:80px;background:#ccc}
    #zoom{position:absolute;left:40px;top:220px;width:300px;height:200px;background:#999;touch-action:none}
    #menu{position:absolute;width:120px;height:60px;background:rgb(255,140,0)}</style>
    <div id="hold"></div><div id="zoom"></div>
    <script>
      document.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const menu = Object.assign(document.createElement('div'), { id: 'menu' });
        menu.style.left = event.clientX + 'px'; menu.style.top = event.clientY + 'px';
        document.body.append(menu);
      });
      const hold = document.getElementById('hold');
      let timer = null;
      hold.addEventListener('pointerdown', () => { timer = setTimeout(() => (hold.style.background = 'rgb(112,72,232)'), 500); });
      hold.addEventListener('pointerup', () => clearTimeout(timer));
      const zoom = document.getElementById('zoom'), down = new Map();
      let start = null;
      zoom.addEventListener('pointerdown', (event) => { down.set(event.pointerId, event.clientX); if (down.size === 2) start = Math.abs([...down.values()][0] - [...down.values()][1]); });
      zoom.addEventListener('pointermove', (event) => { if (down.has(event.pointerId)) down.set(event.pointerId, event.clientX); });
      zoom.addEventListener('pointerup', () => {
        if (down.size === 2 && start && Math.abs([...down.values()][0] - [...down.values()][1]) > start * 1.5) zoom.style.background = 'rgb(0,160,0)';
        down.clear();
      });
    </script>`;
  const serveGestures = () =>
    listen((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(gestures);
    });
  const count = (
    gif: ReturnType<typeof decodeGif>,
    rgba: Uint8Array,
    box: [number, number, number, number],
    match: (rgb: number[]) => boolean,
  ) => {
    let found = 0;
    for (let y = box[1]; y < box[3]; y++) {
      for (let x = box[0]; x < box[2]; x++) if (match(frameAt(gif, rgba, x, y))) found++;
    }
    return found;
  };

  test('the cursor, fingertip and ripple can be restyled, or the cursor replaced with an image', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-style');
    await using server = await serveGestures();
    await fs.writeFile(
      path.join(dir.path, 'hand.png'),
      await PNG.encode({
        width: 16,
        height: 16,
        data: new Uint8Array(16 * 16 * 4).map((_, n) => [0, 255, 255, 255][n % 4]),
      }),
    );
    const tourFile = (name: string, options: string) =>
      fs.writeFile(
        path.join(dir.path, `${name}.tour.ts`),
        `export default { options: ${options}, run: async (tour) => {
          await tour.goto('http://127.0.0.1:${server.port}/');
          await tour.click({ x: 300, y: 120 });
          await tour.wait(300);
        } };`,
      );
    await tourFile(
      'magenta',
      "{ cursor: { size: 48, style: { color: 'rgb(255,0,255)', stroke: 'rgb(255,0,255)' } }, ripple: { style: { color: 'rgb(0,200,0)' } } }",
    );
    await tourFile(
      'image',
      "{ cursor: { image: 'hand.png', hotspot: { x: 0, y: 0 } }, ripple: false }",
    );
    await tourFile(
      'finger',
      "{ touch: true, frame: 'none', finger: { size: 60, style: { background: 'rgb(255,0,0)', borderColor: 'rgb(255,0,0)' } } }",
    );
    const run = (name: string) =>
      shell(
        `node ${CLI} record ${name}.tour.ts -w 400 -h 300 -f ${name}.gif --output=${dir.path}`,
        { ...moduleMetadata, ...testMetadata, cwd: dir.path },
      );
    await Promise.all(['magenta', 'image', 'finger'].map(run));
    const [magenta, image, finger] = await Promise.all(
      ['magenta', 'image', 'finger'].map(async (name) =>
        decodeGif(await fs.readFile(path.join(dir.path, `${name}.gif`))),
      ),
    );
    const around: [number, number, number, number] = [270, 90, 360, 180];
    const isMagenta = (rgb: number[]) => near(rgb, [255, 0, 255], 40);
    const isGreen = (rgb: number[]) => near(rgb, [0, 200, 0], 60);
    const isCyan = (rgb: number[]) => near(rgb, [0, 255, 255], 30);
    const isRed = (rgb: number[]) => near(rgb, [255, 0, 0], 40);

    assert.true(
      count(magenta, magenta.frames.at(-1)!.rgba, around, isMagenta) > 150,
      'a big magenta arrow',
    );
    assert.true(
      magenta.frames.some((frame) => count(magenta, frame.rgba, around, isGreen) > 20),
      'a green ripple',
    );
    assert.true(
      count(image, image.frames.at(-1)!.rgba, [300, 120, 316, 136], isCyan) > 200,
      'the image, its corner on the point',
    );
    assert.equal(
      count(image, image.frames.at(-1)!.rgba, [0, 0, 400, 300], (rgb) =>
        rgb.every((value) => value < 60),
      ),
      0,
      'the image instead of the arrow, not as well as it',
    );
    assert.false(
      image.frames.some(
        (frame) => count(image, frame.rgba, around, (rgb) => near(rgb, [66, 133, 244], 40)) > 20,
      ),
      'no ripple',
    );
    assert.true(
      finger.frames.some((frame) => count(finger, frame.rgba, around, isRed) > 1500),
      'a 60px red fingertip while it taps',
    );
    assert.equal(count(finger, finger.frames.at(-1)!.rgba, around, isRed), 0, 'gone once it lifts');
  });

  test('captions, drawn menus, the phone and the browser frame each take their own look', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-look');
    await using server = await serveGestures();
    const url = `http://127.0.0.1:${server.port}/`;
    await fs.writeFile(
      path.join(dir.path, 'phone.tour.ts'),
      `export default {
        options: {
          frame: 'phone',
          caption: { placement: 'top', style: { background: 'rgb(255,0,0)', color: 'rgb(255,255,255)', fontSize: 26 } },
          menu: { style: { background: 'rgb(0,0,255)', color: 'rgb(255,255,255)' }, highlightStyle: { background: 'rgb(0,255,0)' } },
          phone: { backdrop: 'rgb(0,255,255)', style: { background: 'rgb(255,0,255)' } },
        },
        run: async (tour) => {
          await tour.goto('${url}');
          await tour.caption('Styled');
          await tour.rightClick({ x: 60, y: 460 }, { menu: ['One', 'Two', 'Three'], choose: 'Two' });
        },
      };`,
    );
    await fs.writeFile(
      path.join(dir.path, 'dark.tour.ts'),
      `export default {
        options: {
          frame: 'browser',
          browser: { theme: 'dark' },
          caption: { style: { borderRadius: 0, left: 0, transform: 'none', maxWidth: 'none', width: '100%', bottom: 0 } },
          css: '#caption { border-top: 8px solid rgb(0, 255, 0); }',
        },
        run: async (tour) => { await tour.goto('${url}'); await tour.caption('Full width'); },
      };`,
    );
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    await Promise.all([
      shell(
        `node ${CLI} record phone.tour.ts -w 400 -h 600 -f phone.gif --output=${dir.path}`,
        metadata,
      ),
      shell(
        `node ${CLI} record dark.tour.ts -w 400 -h 300 -f dark.gif --output=${dir.path}`,
        metadata,
      ),
    ]);
    const phone = decodeGif(await fs.readFile(path.join(dir.path, 'phone.gif')));
    const dark = decodeGif(await fs.readFile(path.join(dir.path, 'dark.gif')));
    const size = framedSize('phone', { width: 400, height: 600 });
    const inset = { x: (size.width - 400) / 2, y: size.height - 600 - (size.width - 400) / 2 };
    const last = phone.frames.at(-1)!.rgba;
    const page: [number, number, number, number] = [inset.x, inset.y, inset.x + 400, inset.y + 600];
    const top: [number, number, number, number] = [inset.x, inset.y, inset.x + 400, inset.y + 90];
    const is = (expected: number[]) => (rgb: number[]) => near(rgb, expected, 30);

    assert.true(near(frameAt(phone, last, 3, 3), [0, 255, 255], 30), 'the backdrop');
    assert.true(
      near(frameAt(phone, last, inset.x - 6, inset.y + 300), [255, 0, 255], 30),
      'the bezel',
    );
    assert.true(count(phone, last, top, is([255, 0, 0])) > 1500, 'the caption, red, at the top');
    assert.true(
      phone.frames.some((frame) => count(phone, frame.rgba, page, is([0, 0, 255])) > 3000),
      'the menu, blue',
    );
    assert.true(
      phone.frames.some((frame) => count(phone, frame.rgba, page, is([0, 255, 0])) > 1500),
      'its highlighted item, green',
    );
    assert.true(
      frameAt(dark, dark.frames[0].rgba, 300, 10).every((value) => value < 70),
      'a dark tab strip',
    );
    assert.true(
      frameAt(dark, dark.frames[0].rgba, 300, 55).every((value) => value < 90),
      'and a dark address bar',
    );
    const band = [0, 0, 400, 300 + 74].map(Number) as [number, number, number, number];
    const green = count(dark, dark.frames.at(-1)!.rgba, band, is([0, 255, 0]));
    assert.true(
      green > 400 * 8 * 0.9 && green < 400 * 8 * 1.2,
      `any CSS: a square caption across the whole width, with the css string's green top border (${green} px)`,
    );
  });

  test('a chapter card, a highlight and keystroke badges are drawn, each in its own style', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-story');
    await using server = await listen((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<body style="margin:0;background:#fff"><div id="target" style="position:absolute;left:100px;top:100px;width:200px;height:60px"></div>',
      );
    });
    const url = `http://127.0.0.1:${server.port}/`;
    const kbd = "css: '#keys kbd { background: rgb(0, 200, 0); }'";
    await fs.writeFile(
      path.join(dir.path, 'story.tour.ts'),
      `export default {
        options: {
          chapter: { style: { background: 'rgb(0,0,255)' } },
          highlight: { style: { outlineColor: 'rgb(255,0,255)', outlineWidth: 4, boxShadow: '0 0 0 100vmax rgba(0,0,0,.5)' } },
          ${kbd},
        },
        run: async (tour) => {
          await tour.goto('${url}');
          await tour.chapter('One', { subtitle: 'two', durationMs: 1000 });
          await tour.highlight('#target', { padding: 10 });
          await tour.press('Control+K');
          await tour.highlight(null);
          await tour.wait(200);
        },
      };`,
    );
    await fs.writeFile(
      path.join(dir.path, 'quiet.tour.ts'),
      `export default { options: { keys: false, ${kbd} }, run: async (tour) => { await tour.goto('${url}'); await tour.press('Control+K'); } };`,
    );
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    await Promise.all(
      ['story', 'quiet'].map((name) =>
        shell(
          `node ${CLI} record ${name}.tour.ts -w 400 -h 300 -f ${name}.gif --output=${dir.path}`,
          metadata,
        ),
      ),
    );
    const story = decodeGif(await fs.readFile(path.join(dir.path, 'story.gif')));
    const quiet = decodeGif(await fs.readFile(path.join(dir.path, 'quiet.gif')));
    const all: [number, number, number, number] = [0, 0, 400, 300];
    const is =
      (expected: number[], tolerance = 30) =>
      (rgb: number[]) =>
        near(rgb, expected, tolerance);
    const centres = story.frames.map((frame) => frameAt(story, frame.rgba, 30, 280));
    const lit = story.frames.filter(
      (frame) => count(story, frame.rgba, [80, 80, 320, 180], is([255, 0, 255], 40)) > 600,
    );
    const isGreen = is([0, 200, 0], 40);

    assert.true(
      story.frames.some(
        (frame) => count(story, frame.rgba, all, is([0, 0, 255])) > 400 * 300 * 0.8,
      ),
      'the chapter card covers the frame, in its blue',
    );
    assert.true(
      centres.some(([red, , blue]) => red > 20 && red < 235 && blue > 225),
      'and fades: a frame part way from the page to the card',
    );
    assert.true(lit.length > 0, 'the highlight outlined in magenta');
    assert.true(
      lit.every(
        (frame) =>
          near(frameAt(story, frame.rgba, 200, 130), [255, 255, 255], 10) &&
          near(frameAt(story, frame.rgba, 380, 280), [128, 128, 128], 30),
      ),
      'the target left bright, the rest dimmed',
    );
    assert.true(
      story.frames.some((frame) => count(story, frame.rgba, all, isGreen) > 300),
      'the keystroke as green badges',
    );
    assert.true(
      near(frameAt(story, story.frames.at(-1)!.rgba, 380, 280), [255, 255, 255], 10) &&
        count(story, story.frames.at(-1)!.rgba, all, isGreen) === 0,
      'all gone at the end',
    );
    assert.false(
      quiet.frames.some((frame) => count(quiet, frame.rgba, all, isGreen) > 0),
      'keys: false shows no badges',
    );
  });

  test('double clicks, selects, uploads, fills and scrolls inside an element reach the page for real', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-inputs');
    const green = 'rgb(0,160,0)';
    const box = (id: string, left: number, top: number) =>
      `<div id="${id}" style="position:absolute;left:${left}px;top:${top}px;width:30px;height:30px;background:rgb(220,220,220)"></div>`;
    await using server = await listen((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<body style="margin:0;font:16px sans-serif">
        <div id="word" ondblclick="this.style.background='${green}'" style="position:absolute;left:20px;top:20px;width:160px;height:40px;background:rgb(200,200,200)"></div>
        <select id="size" onchange="if (this.value === 'l') document.getElementById('picked').style.background='${green}'" style="position:absolute;left:220px;top:20px;width:150px;height:36px">
          <option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option>
        </select>
        <input id="name" value="old text" oninput="if (this.value === 'new text') document.getElementById('filled').style.background='${green}'" style="position:absolute;left:20px;top:80px;width:200px;height:30px">
        <button id="attach" onclick="document.getElementById('file').click()" style="position:absolute;left:240px;top:80px;width:100px;height:30px">Attach</button>
        <input id="file" type="file" hidden onchange="if (this.files[0].name === 'notes.txt') document.getElementById('attached').style.background='${green}'">
        <div id="list" style="position:absolute;left:20px;top:130px;width:200px;height:120px;overflow:auto">
          <div style="height:600px;background:linear-gradient(rgb(255,0,0) 0 120px, rgb(0,0,255) 120px)"></div>
        </div>
        ${box('picked', 240, 260)}${box('filled', 280, 260)}${box('attached', 320, 260)}
      </body>`);
    });
    const url = `http://127.0.0.1:${server.port}/`;
    await fs.writeFile(path.join(dir.path, 'notes.txt'), 'notes');
    await fs.writeFile(
      path.join(dir.path, 'inputs.tour.ts'),
      `export default async (tour) => {
        await tour.goto('${url}');
        await tour.doubleClick('#word');
        await tour.select('#size', 'Large');
        await tour.fill('#name', 'new text');
        await tour.upload('#attach', 'notes.txt');
        await tour.scroll({ y: 200 }, { within: '#list' });
      };`,
    );
    await fs.writeFile(
      path.join(dir.path, 'option.tour.ts'),
      `export default async (tour) => { await tour.goto('${url}'); await tour.select('#size', 'Huge'); };`,
    );
    await fs.writeFile(
      path.join(dir.path, 'missing.tour.ts'),
      `export default async (tour) => { await tour.goto('${url}'); await tour.upload('#attach', 'nope.txt'); };`,
    );
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    const [, option, missing] = await Promise.all([
      shell(
        `node ${CLI} record inputs.tour.ts -w 400 -h 300 -f inputs.gif --output=${dir.path}`,
        metadata,
      ),
      shellFails(`node ${CLI} record option.tour.ts -f option.gif --output=${dir.path}`, metadata),
      shellFails(
        `node ${CLI} record missing.tour.ts -f missing.gif --output=${dir.path}`,
        metadata,
      ),
    ]);
    const gif = decodeGif(await fs.readFile(path.join(dir.path, 'inputs.gif')));
    const last = gif.frames.at(-1)!.rgba;
    const isGreen = (x: number, y: number) => near(frameAt(gif, last, x, y), [0, 160, 0], 25);
    const menuBlue = (rgb: number[]) => near(rgb, [26, 115, 232], 30);

    assert.true(isGreen(100, 40), 'the double click reached the page');
    assert.true(isGreen(255, 275), 'the option was picked');
    assert.true(isGreen(295, 275), 'the field was filled, replacing what it held');
    assert.true(isGreen(335, 275), 'the file reached the input the button opened');
    assert.true(
      near(frameAt(gif, last, 100, 140), [0, 0, 255], 30),
      'the list scrolled to its blue part',
    );
    assert.true(near(frameAt(gif, last, 100, 40), [0, 160, 0], 25), 'and the page itself did not');
    assert.true(
      gif.frames.some((frame) => count(gif, frame.rgba, [220, 56, 380, 170], menuBlue) > 1500),
      "the select's options drawn, the chosen one highlighted",
    );
    assert.includes(option.stderr, '"Huge" is not an option of #size: "Small", "Medium", "Large"');
    assert.includes(missing.stderr, 'nope.txt: no such file');
  });

  test('@keyframes in the look run on the tour clock: frame by frame, restarted by a new caption, the same every run', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-animation');
    await using server = await listen((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<body style="margin:0;background:#fff">');
    });
    await fs.writeFile(
      path.join(dir.path, 'fade.tour.ts'),
      `export default {
        options: {
          caption: { style: { width: '300px', height: '40px', color: 'transparent', background: 'rgb(0,0,0)' } },
          css: '@keyframes in { from { opacity: 0; } } #caption { animation: in 1s linear; }',
        },
        run: async (tour) => {
          await tour.goto('http://127.0.0.1:${server.port}/');
          await tour.caption('First');
          await tour.wait(1500);
          await tour.caption('Second');
          await tour.wait(1500);
        },
      };`,
    );
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    await Promise.all(
      ['one', 'two'].map((name) =>
        shell(
          `node ${CLI} record fade.tour.ts -w 400 -h 300 -f ${name}.gif --output=${dir.path}`,
          metadata,
        ),
      ),
    );
    const [one, two] = await Promise.all(
      ['one', 'two'].map(async (name) =>
        decodeGif(await fs.readFile(path.join(dir.path, `${name}.gif`))),
      ),
    );
    const shades = one.frames.map((frame) => frameAt(one, frame.rgba, 200, 255)[0]);
    const darkening = (from: number) => {
      let run = 0;
      for (
        let index = from + 1;
        index < shades.length && shades[index] < shades[index - 1];
        index++
      )
        run++;
      return run;
    };
    const restart = shades.findIndex(
      (shade, index) => index > 0 && shade > shades[index - 1] + 100,
    );

    assert.true(
      darkening(shades.findIndex((shade) => shade < 250)) >= 7,
      `fades in a frame per tick (${shades.join(' ')})`,
    );
    assert.true(
      restart > 0 && darkening(restart) >= 7,
      `and again from the start for the next caption (${shades.join(' ')})`,
    );
    assert.true(shades.at(-1)! < 10, 'ending fully shown');
    assert.deepEqual(
      two.frames.map((frame) => frame.delayMs),
      one.frames.map((frame) => frame.delayMs),
      'the same timing every run',
    );
    assert.true(
      two.frames.every((frame, index) => Buffer.compare(frame.rgba, one.frames[index].rgba) === 0),
      'and the same pixels',
    );
  });

  test('move() glides the cursor to a point, a selector, or along a path, hovering what it passes', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-move');
    await using server = await listen((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<body style="margin:0;background:#fff"><div id="b" onmouseover="this.style.background=\'rgb(0,160,0)\'" style="position:absolute;left:150px;top:100px;width:100px;height:60px;background:rgb(200,200,200)"></div>',
      );
    });
    const url = `http://127.0.0.1:${server.port}/`;
    await fs.writeFile(
      path.join(dir.path, 'path.tour.ts'),
      `export default async (tour) => {
        await tour.goto('${url}');
        await tour.move([{ x: 30, y: 30 }, '#b', { x: 360, y: 250 }], { durationMs: 1500 });
      };`,
    );
    await fs.writeFile(
      path.join(dir.path, 'touch.tour.ts'),
      `export default { options: { touch: true }, run: async (tour) => { await tour.goto('${url}'); await tour.move('#b'); } };`,
    );
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    const [, touch] = await Promise.all([
      shell(
        `node ${CLI} record path.tour.ts -w 400 -h 300 --last-frame-duration 0 -f path.gif --output=${dir.path}`,
        metadata,
      ),
      shellFails(`node ${CLI} record touch.tour.ts -f touch.gif --output=${dir.path}`, metadata),
    ]);
    const gif = decodeGif(await fs.readFile(path.join(dir.path, 'path.gif')));
    const dark = (frame: { rgba: Uint8Array }, box: [number, number, number, number]) =>
      count(gif, frame.rgba, box, (rgb) => rgb.every((value) => value < 60));
    const at = (point: { x: number; y: number }) =>
      gif.frames.findIndex(
        (frame) => dark(frame, [point.x - 2, point.y - 2, point.x + 18, point.y + 24]) > 15,
      );
    const stops = [at({ x: 30, y: 30 }), at({ x: 360, y: 250 })];

    assert.true(
      stops[0] >= 0 && stops[1] > stops[0],
      `the cursor reaches each stop in turn (${stops})`,
    );
    assert.true(dark(gif.frames.at(-1)!, [358, 248, 378, 274]) > 15, 'and ends on the last');
    assert.true(
      near(frameAt(gif, gif.frames.at(-1)!.rgba, 160, 150), [0, 160, 0], 25),
      'the real mouse passed over the selector on its way',
    );
    assert.includes(
      touch.stderr,
      'move() has no finger to show on a touch screen: drag or swipe instead',
    );
  });

  test('a highlight follows its target as the page scrolls; maxZoom keeps a deep zoom sharp', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-follow');
    await using server = await listen((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<body style="margin:0;height:1500px;background:#fff">
        <div id="t" style="position:absolute;left:100px;top:500px;width:200px;height:40px"></div>
        <div id="s" style="position:absolute;left:180px;top:30px;width:40px;height:40px;background:repeating-linear-gradient(90deg,#000 0 .25px,#fff .25px .5px)"></div>`);
    });
    const url = `http://127.0.0.1:${server.port}/`;
    await fs.writeFile(
      path.join(dir.path, 'follow.tour.ts'),
      `export default {
        options: { highlight: { style: { outline: '4px solid rgb(255,0,255)', boxShadow: 'none' } } },
        run: async (tour) => {
          await tour.goto('${url}');
          await tour.highlight('#t', { padding: 0 });
          await tour.scroll({ y: 100 });
        },
      };`,
    );
    const zoomTour = (options: string) =>
      `export default { options: ${options}, run: async (tour) => { await tour.goto('${url}'); await tour.zoom('#s', { scale: 4, durationMs: 100 }); } };`;
    await fs.writeFile(path.join(dir.path, 'soft.tour.ts'), zoomTour('{}'));
    await fs.writeFile(path.join(dir.path, 'sharp.tour.ts'), zoomTour('{ maxZoom: 4 }'));
    await fs.writeFile(path.join(dir.path, 'huge.tour.ts'), zoomTour('{ maxZoom: 9 }'));
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    const run = (name: string) =>
      shell(
        `node ${CLI} record ${name}.tour.ts -w 400 -h 300 -f ${name}.gif --output=${dir.path}`,
        metadata,
      );
    const [, , , huge] = await Promise.all([
      run('follow'),
      run('soft'),
      run('sharp'),
      shellFails(`node ${CLI} record huge.tour.ts -f huge.gif --output=${dir.path}`, metadata),
    ]);
    const [follow, soft, sharp] = await Promise.all(
      ['follow', 'soft', 'sharp'].map(async (name) =>
        decodeGif(await fs.readFile(path.join(dir.path, `${name}.gif`))),
      ),
    );
    // The outline's top edge: the first row with a long run of magenta.
    const outlineTop = (rgba: Uint8Array) => {
      for (let y = 0; y < 300; y++) {
        if (count(follow, rgba, [100, y, 300, y + 1], (rgb) => near(rgb, [255, 0, 255], 40)) > 150)
          return y;
      }
      return -1;
    };
    const tops = follow.frames.map((frame) => outlineTop(frame.rgba)).filter((top) => top >= 0);
    // Stripes a quarter of a CSS pixel wide: a 4× shot has a device pixel for each, so the zoom
    // shows black beside white; a 2× shot cannot — Chromium averages them to grey, WebKit to blobs.
    const stripes = (gif: ReturnType<typeof decodeGif>) => {
      const { rgba } = gif.frames.at(-1)!;
      const at = (x: number, y: number) => rgba[(y * gif.width + x) * 4];
      return Array.from({ length: 150 }, (_, row) => row + 75).reduce(
        (edges, y) =>
          edges +
          Array.from({ length: 199 }, (_, column) => column + 100).filter(
            (x) => Math.abs(at(x, y) - at(x + 1, y)) > 135,
          ).length,
        0,
      );
    };

    assert.true(tops.length > 2, `the highlight shows throughout (${tops})`);
    assert.true(
      Math.abs(tops[0] - tops.at(-1)! - 100) <= 2,
      `and moved up with the 100px scroll (${tops})`,
    );
    assert.true(
      stripes(sharp) > stripes(soft) * 10 + 1000,
      `maxZoom: 4 resolves detail the default 2× cannot (${stripes(sharp)} vs ${stripes(soft)} stripe edges)`,
    );
    assert.includes(huge.stderr, 'maxZoom must be a number from 1 to 4, not 9');
  });

  test('the address bar follows a link, an SPA route and a hash, as if the page had been opened there', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-address');
    // One page at every path, with one title: only the address bar can tell them apart.
    await using server = await listen((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<title>App</title><body style="margin:0;background:#fff">
        <a id="link" href="/about" style="display:block;margin:120px 20px 0">About</a>
        <button id="spa" onclick="history.pushState({}, '', '/spa/route')" style="margin:10px 20px">Route</button>
        <a id="hash" href="#section" style="margin:10px 20px">Section</a>`);
    });
    const base = `http://127.0.0.1:${server.port}`;
    const tours: Record<string, string> = {
      link: `await tour.goto('${base}/'); await tour.click('#link');`,
      spa: `await tour.goto('${base}/'); await tour.click('#spa');`,
      hash: `await tour.goto('${base}/'); await tour.click('#hash');`,
      about: `await tour.goto('${base}/about');`,
      route: `await tour.goto('${base}/spa/route');`,
      section: `await tour.goto('${base}/#section');`,
    };
    for (const [name, steps] of Object.entries(tours)) {
      await fs.writeFile(
        path.join(dir.path, `${name}.tour.ts`),
        `export default { options: { frame: 'browser' }, run: async (tour) => { ${steps} await tour.wait(200); } };`,
      );
    }
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    await Promise.all(
      Object.keys(tours).map((name) =>
        shell(
          `node ${CLI} record ${name}.tour.ts -w 400 -h 300 -f ${name}.gif --output=${dir.path}`,
          metadata,
        ),
      ),
    );
    const gifs = Object.fromEntries(
      await Promise.all(
        Object.keys(tours).map(
          async (name) =>
            [name, decodeGif(await fs.readFile(path.join(dir.path, `${name}.gif`)))] as const,
        ),
      ),
    );
    // Pixels of the address field that differ between two frames.
    const differ = (
      a: ReturnType<typeof decodeGif>,
      aFrame: Uint8Array,
      b: ReturnType<typeof decodeGif>,
      bFrame: Uint8Array,
    ) => {
      let count = 0;
      for (let y = 42; y < 68; y++) {
        for (let x = 12; x < 388; x++) {
          if (!near(frameAt(a, aFrame, x, y), frameAt(b, bFrame, x, y), 40)) count++;
        }
      }
      return count;
    };
    const last = (name: string) => gifs[name].frames.at(-1)!.rgba;

    for (const [clicked, direct] of [
      ['link', 'about'],
      ['spa', 'route'],
      ['hash', 'section'],
    ]) {
      assert.true(
        differ(gifs[clicked], gifs[clicked].frames[0].rgba, gifs[clicked], last(clicked)) > 50,
        `${clicked}: the address changed`,
      );
      assert.true(
        differ(gifs[clicked], last(clicked), gifs[direct], last(direct)) < 15,
        `${clicked}: to what opening ${direct} directly shows`,
      );
    }
  });

  test('addressBar: false draws the window with its tabs only, and the phone as an app', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-no-address');
    await using server = await listen((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<title>App</title><body style="margin:0;background:rgb(0,160,0)">');
    });
    const url = `http://127.0.0.1:${server.port}/`;
    const tourFile = (name: string, options: string) =>
      fs.writeFile(
        path.join(dir.path, `${name}.tour.ts`),
        `export default { options: ${options}, run: async (tour) => { await tour.goto('${url}'); } };`,
      );
    await tourFile('window', "{ frame: 'browser', addressBar: false }");
    await tourFile('app', '{ touch: true, addressBar: false }');
    await tourFile('bad', "{ addressBar: 'no' }");
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    const [, , bad] = await Promise.all([
      shell(
        `node ${CLI} record window.tour.ts -w 400 -h 300 -f window.gif --output=${dir.path}`,
        metadata,
      ),
      shell(
        `node ${CLI} record app.tour.ts -w 300 -h 500 -f app.gif --output=${dir.path}`,
        metadata,
      ),
      shellFails(`node ${CLI} record bad.tour.ts -f bad.gif --output=${dir.path}`, metadata),
    ]);
    const window = decodeGif(await fs.readFile(path.join(dir.path, 'window.gif')));
    const app = decodeGif(await fs.readFile(path.join(dir.path, 'app.gif')));
    const phone = framedSize('phone', { width: 300, height: 500 }, false);
    const inset = (phone.width - 300) / 2;
    const green = (gif: ReturnType<typeof decodeGif>, x: number, y: number) =>
      near(frameAt(gif, gif.frames[0].rgba, x, y), [0, 160, 0], 30);

    assert.deepEqual(
      [window.width, window.height],
      [400, 300 + 36],
      'the tab strip and nothing else',
    );
    assert.true(green(window, 200, 37), 'the page starts right under the tabs');
    assert.deepEqual([app.width, app.height], [phone.width, phone.height]);
    assert.true(green(app, phone.width / 2, inset + 2), 'the screen starts right under the bezel');
    assert.includes(bad.stderr, 'addressBar must be true or false, not "no"');
  });

  test("-f pdf prints a tour's steps, a page each, in its frame and with its panel", async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-pdf');
    await fs.writeFile(path.join(dir.path, 'home.html'), '<title>Home</title><p>Home');
    await fs.writeFile(path.join(dir.path, 'checkout.html'), '<title>Checkout</title><p>Pay');
    const base = pathToFileURL(dir.path).href;
    await fs.writeFile(
      path.join(dir.path, 'buy.tour.ts'),
      `export default async (tour) => { await tour.goto('${base}/home.html'); await tour.open('${base}/checkout.html'); };`,
    );
    const result = await shell(
      `node ${CLI} record buy.tour.ts -w 300 -h 200 -f buy.pdf --output=${dir.path}`,
      { ...moduleMetadata, ...testMetadata, cwd: dir.path },
    );
    const pdf = parsePdf(await fs.readFile(path.join(dir.path, 'buy.pdf')));

    // One step: the page, the browser frame its second tab brought (74), and the panel (96).
    assert.includes(result.stdout, 'buy.pdf  300×370  1 page');
    assert.equal(pdf.title, 'buy', "the recording's name");
  });

  test('a gesture of 2 to 10 fingers is that many real touches, each finger drawn, each with its ripple', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-fingers');
    // The most pointers down at once, as a bar 20px a finger wide, and a target to touch.
    await using server = await listen((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      // A phone lays a page out at 980px and shrinks it unless the page says otherwise.
      response.end(`<meta name="viewport" content="width=device-width"><body style="margin:0;background:#fff">
        <div id="pad" style="position:absolute;left:20px;top:150px;width:360px;height:300px;background:rgb(240,240,240);touch-action:none"></div>
        <div id="bar" style="position:absolute;left:0;top:0;height:20px;width:0;background:rgb(0,0,255)"></div>
        <script>
          const down = new Set(); let most = 0;
          addEventListener('pointerdown', (event) => { down.add(event.pointerId); most = Math.max(most, down.size); });
          addEventListener('pointerup', (event) => { down.delete(event.pointerId); document.getElementById('bar').style.width = most * 20 + 'px'; });
        </script>`);
    });
    const url = `http://127.0.0.1:${server.port}/`;
    const look =
      "finger: { size: 30, style: { background: 'rgb(255,0,255)', borderColor: 'rgb(255,0,255)', boxShadow: 'none' } }, ripple: { style: { color: 'rgb(0,200,0)' } }";
    const tours: Record<string, string> = {
      one: `await tour.tap('#pad');`,
      swipe: `await tour.swipe('#pad', 'left', { fingers: 3 });`,
      tap: `await tour.tap('#pad', { fingers: 4 });`,
      pinch: `await tour.pinch('#pad', { fingers: 10, scale: 1.5, rotate: 45 });`,
      labelled: `await tour.tap('#pad', { fingers: 4 });`,
    };
    for (const [name, step] of Object.entries(tours)) {
      const labels = name === 'labelled' ? ', labels: true' : '';
      await fs.writeFile(
        path.join(dir.path, `${name}.tour.ts`),
        `export default { options: { touch: true, frame: 'none', ${look.replace('size: 30', `size: 30${labels}`)} }, run: async (tour) => { await tour.goto('${url}'); ${step} await tour.wait(200); } };`,
      );
    }
    await fs.writeFile(
      path.join(dir.path, 'eleven.tour.ts'),
      `export default { options: { touch: true }, run: async (tour) => { await tour.goto('${url}'); await tour.swipe('#pad', 'up', { fingers: 11 }); } };`,
    );
    await fs.writeFile(
      path.join(dir.path, 'lone.tour.ts'),
      `export default { options: { touch: true }, run: async (tour) => { await tour.goto('${url}'); await tour.pinch('#pad', { fingers: 1 }); } };`,
    );
    await fs.writeFile(
      path.join(dir.path, 'desk.tour.ts'),
      `export default async (tour) => { await tour.goto('${url}'); await tour.tap('#pad', { fingers: 2 }); };`,
    );
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    await Promise.all(
      Object.keys(tours).map((name) =>
        shell(
          `node ${CLI} record ${name}.tour.ts -w 400 -h 500 -f ${name}.gif,${name}.png --last-frame-duration 0 --output=${dir.path}`,
          metadata,
        ),
      ),
    );
    const [eleven, lone, desk] = await Promise.all(
      ['eleven', 'lone', 'desk'].map((name) =>
        shellFails(
          `node ${CLI} record ${name}.tour.ts -f ${name}.gif --output=${dir.path}`,
          metadata,
        ),
      ),
    );
    const gifs = Object.fromEntries(
      await Promise.all(
        Object.keys(tours).map(
          async (name) =>
            [name, decodeGif(await fs.readFile(path.join(dir.path, `${name}.gif`)))] as const,
        ),
      ),
    );
    const bars = Object.fromEntries(
      await Promise.all(
        Object.keys(tours).map(async (name) => {
          const still = PNG.decode(await fs.readFile(path.join(dir.path, `${name}.png`)));
          // The bar runs from the left edge to the first column that is not blue.
          const end = Array.from({ length: still.width }, (_, x) => x).findIndex(
            (x) => !near(pixel(still, x, 10), [0, 0, 255], 40),
          );
          return [name, Math.round((end === -1 ? still.width : end) / 20)] as const;
        }),
      ),
    );
    // The most of a color in any one frame.
    const most = (name: string, rgb: number[]) =>
      Math.max(
        ...gifs[name].frames.map((frame) =>
          count(gifs[name], frame.rgba, [0, 0, 400, 500], (value) => near(value, rgb, 40)),
        ),
      );
    // A ripple fades as it spreads, blending into what is under it: green-ish is enough.
    const greenish = (name: string) =>
      Math.max(
        ...gifs[name].frames.map((frame) =>
          count(
            gifs[name],
            frame.rgba,
            [0, 0, 400, 500],
            ([red, green, blue]) => green - Math.max(red, blue) > 40,
          ),
        ),
      );
    const fingertip = most('one', [255, 0, 255]);
    const ripple = greenish('one');

    assert.deepEqual(
      [bars.one, bars.swipe, bars.tap, bars.pinch],
      [1, 3, 4, 10],
      'the page felt one, three, four and ten fingers down at once',
    );
    for (const [name, fingers] of [
      ['swipe', 3],
      ['tap', 4],
      ['pinch', 10],
    ] as const) {
      const ratio = most(name, [255, 0, 255]) / fingertip;
      assert.true(
        Math.abs(ratio - fingers) < fingers * 0.2,
        `${name}: ${fingers} fingertips drawn (${ratio.toFixed(1)}×)`,
      );
    }
    assert.true(
      Math.abs(greenish('tap') / ripple - 4) < 1,
      `a ripple under each of the four (${(greenish('tap') / ripple).toFixed(1)}×)`,
    );
    assert.true(
      most('labelled', [255, 0, 255]) < most('tap', [255, 0, 255]) * 0.97,
      'labels write their numbers on the fingertips',
    );
    assert.includes(eleven.stderr, 'swipe() takes 1 to 10 fingers, not 11');
    assert.includes(lone.stderr, 'pinch() takes 2 to 10 fingers, not 1');
    assert.includes(desk.stderr, 'tap() with 2 fingers needs a touch tour');
  });

  test('CSS the browser would not take fails before the tour runs, naming it', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-bad-css');
    const tourFile = (name: string, options: string) =>
      fs.writeFile(
        path.join(dir.path, `${name}.tour.ts`),
        `export default { options: ${options}, run: async () => { throw new Error('ran'); } };`,
      );
    await tourFile('property', "{ caption: { style: { colr: 'red' } } }");
    await tourFile('value', "{ menu: { highlightStyle: { background: 'reddish' } } }");
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
    const failures = await Promise.all(
      ['property', 'value'].map(
        async (name) =>
          (
            await shellFails(
              `node ${CLI} record ${name}.tour.ts -f ${name}.gif --output=${dir.path}`,
              metadata,
            )
          ).stderr,
      ),
    );

    assert.includes(failures[0], 'caption.style.colr is not a CSS property');
    assert.includes(
      failures[1],
      'menu.highlightStyle.background: "reddish" is not a valid background',
    );
    assert.false(failures.join('').includes('ran'), 'checked before the tour ran');
  });

  test("right-click reaches the page's own menu; a drawn menu can be chosen from", async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-rightclick');
    await using server = await serveGestures();
    await fs.writeFile(
      path.join(dir.path, 'menu.tour.ts'),
      `export default async (tour) => {
        await tour.goto('http://127.0.0.1:${server.port}/');
        await tour.rightClick({ x: 200, y: 140 });
        await tour.rightClick({ x: 120, y: 450 }, { menu: ['Copy', 'Paste', 'Delete'], choose: 'Paste' });
      };`,
    );

    await shell(`node ${CLI} record menu.tour.ts -w 400 -h 600 -f menu.gif --output=${dir.path}`, {
      ...moduleMetadata,
      ...testMetadata,
      cwd: dir.path,
    });
    const gif = decodeGif(await fs.readFile(path.join(dir.path, 'menu.gif')));
    const isOrange = (rgb: number[]) => near(rgb, [255, 140, 0], 30);
    const isHighlight = (rgb: number[]) => near(rgb, [26, 115, 232], 30);
    const drawn: [number, number, number, number] = [120, 450, 330, 560];

    assert.true(
      count(gif, gif.frames.at(-1)!.rgba, [200, 140, 320, 200], isOrange) > 3000,
      "the page's own menu, where it was right-clicked",
    );
    assert.true(
      gif.frames.some((frame) => count(gif, frame.rgba, drawn, isHighlight) > 1000),
      'the drawn menu, "Paste" highlighted',
    );
    assert.equal(count(gif, gif.frames.at(-1)!.rgba, drawn, isHighlight), 0, 'closed once chosen');
  });

  test('a long press holds for real; a pinch spreads two fingers; each refuses the wrong screen', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-gestures');
    await using server = await serveGestures();
    const url = `http://127.0.0.1:${server.port}/`;
    await fs.writeFile(
      path.join(dir.path, 'touch.tour.ts'),
      `export default { options: { touch: true, frame: 'none' }, run: async (tour) => {
        await tour.goto('${url}');
        await tour.longPress('#hold');
        await tour.pinch('#zoom', { scale: 2.5 });
      } };`,
    );
    await fs.writeFile(
      path.join(dir.path, 'desktop-pinch.tour.ts'),
      `export default async (tour) => { await tour.goto('${url}'); await tour.pinch('#zoom'); };`,
    );
    await fs.writeFile(
      path.join(dir.path, 'touch-right.tour.ts'),
      `export default { options: { touch: true }, run: async (tour) => { await tour.goto('${url}'); await tour.rightClick('#hold'); } };`,
    );
    const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };

    const [, pinchOnDesktop, rightClickOnTouch] = await Promise.all([
      shell(
        `node ${CLI} record touch.tour.ts -w 400 -h 600 -f touch.gif --output=${dir.path}`,
        metadata,
      ),
      shellFails(
        `node ${CLI} record desktop-pinch.tour.ts -w 400 -h 600 --output=${dir.path}`,
        metadata,
      ),
      shellFails(
        `node ${CLI} record touch-right.tour.ts -w 400 -h 600 --output=${dir.path}`,
        metadata,
      ),
    ]);
    const gif = decodeGif(await fs.readFile(path.join(dir.path, 'touch.gif')));
    const last = gif.frames.at(-1)!.rgba;
    // Two white fingertip rims over the grey #zoom, far enough apart to be two.
    const fingertips = (rgba: Uint8Array) => {
      const columns = new Set<number>();
      for (let y = 300; y < 340; y++) {
        for (let x = 40; x < 340; x++)
          if (frameAt(gif, rgba, x, y).every((value) => value > 240))
            columns.add(Math.floor(x / 60));
      }
      return columns.size;
    };

    assert.true(
      near(frameAt(gif, last, 100, 80), [112, 72, 232]),
      "the page's long-press fired: it was held for real",
    );
    assert.true(
      near(frameAt(gif, last, 300, 400), [0, 160, 0]),
      'the page saw two fingers spread apart',
    );
    assert.true(
      gif.frames.some((frame) => fingertips(frame.rgba) >= 2),
      'two fingertips drawn during the pinch',
    );
    assert.includes(pinchOnDesktop.stderr, 'pinch() takes two fingers: it needs a touch tour');
    assert.includes(
      rightClickOnTouch.stderr,
      'a touch screen has no right-click: longPress() is its context menu',
    );
  });

  test('a tour file that exports no tour says what it needs, exit 1', async (assert, testMetadata) => {
    await using dir = await tempDir('record-tour-bad');
    await fs.writeFile(path.join(dir.path, 'bad.tour.ts'), 'export const notATour = 1;');

    const result = await shellFails(`node ${CLI} record bad.tour.ts --output=${dir.path}`, {
      ...moduleMetadata,
      ...testMetadata,
      cwd: dir.path,
    });

    assert.exitCode(result, 1);
    assert.includes(
      result.stderr,
      'it must export default an async function, or tour(...) from qunitx-cli',
    );
  });
});

module('Commands | record | arguments', { concurrency: true }, (_hooks, moduleMetadata) => {
  test('--help exits 0 with the usage; a bad flag, no input or a comment without its images exit 2', async (assert, testMetadata) => {
    const metadata = { ...moduleMetadata, ...testMetadata };
    const [help, badFlag, noInput, commentWithoutImages] = await Promise.all([
      shell(`node ${CLI} record --help`, metadata),
      shellFails(`node ${CLI} record page.html -w wide`, metadata),
      shellFails(`node ${CLI} record`, metadata),
      shellFails(`node ${CLI} record page.html --pr-comment`, metadata),
    ]);

    assert.includes(help.stdout, 'Usage: qunitx record');
    assert.exitCode(badFlag, 2);
    assert.includes(badFlag.stderr, 'qunitx record -w: expected a whole number of pixels');
    assert.exitCode(noInput, 2);
    assert.includes(noInput.stderr, 'needs at least one URL, page or script');
    assert.exitCode(commentWithoutImages, 2);
    assert.includes(commentWithoutImages.stderr, 'prComment: needs imagesUrl (--images-url)');
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

module(
  'Commands | record | report and settings as PDF',
  { concurrency: true },
  (_hooks, moduleMetadata) => {
    test('--report=html,pdf writes both, --report=pdf the PDF alone, and an unknown format is refused', async (assert, testMetadata) => {
      await using dir = await tempDir('record-report-pdf');
      const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
      await fs.writeFile(path.join(dir.path, 'a.html'), page('rgb(0,0,255)'));
      const shoot = (flags: string, output: string) =>
        shell(`node ${CLI} record a.html -w 120 -h 80 -o ${output} ${flags}`, metadata).catch(
          (error) => error,
        );
      await Promise.all([shoot('--compare', 'both'), shoot('--compare', 'pdf-only')]);
      await fs.writeFile(path.join(dir.path, 'a.html'), page('rgb(255,0,0)'));
      const [both, alone, unknown] = await Promise.all([
        shoot('--report=html,pdf', 'both'),
        shoot('--report=pdf', 'pdf-only'),
        shellFails(`node ${CLI} record a.html --report=xml`, metadata),
      ]);
      const pdf = parsePdf(await fs.readFile(path.join(dir.path, 'both', 'report.pdf')));

      assert.includes(both.stdout, `${path.join('both', 'report.html')}  report`);
      assert.includes(both.stdout, `${path.join('both', 'report.pdf')}  report`);
      assert.true(
        pdf.pages.length >= 1 && /1 changed/.test(pdf.title ?? ''),
        `a PDF of it, titled as the report is (${pdf.pages.length} pages, ${pdf.title})`,
      );
      assert.includes(alone.stdout, `${path.join('pdf-only', 'report.pdf')}  report`);
      assert.false(
        await fs.stat(path.join(dir.path, 'pdf-only', 'report.html')).then(
          () => true,
          () => false,
        ),
        'and no report.html when only the PDF was asked for',
      );
      assert.includes(
        unknown.stderr,
        "expected true, 'html', 'pdf' or ['html', 'pdf'], got \"xml\"",
      );
    });

    test('package.json sets the PDF settings and the report formats; a flag changes one setting of them', async (assert, testMetadata) => {
      await using dir = await tempDir('record-config-pdf');
      const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
      const manifest = (record: unknown) =>
        fs.writeFile(path.join(dir.path, 'package.json'), JSON.stringify({ qunitx: { record } }));
      await fs.writeFile(path.join(dir.path, 'a.html'), page('rgb(0,0,255)', '<p>Hello</p>'));
      await manifest({
        inputs: ['a.html'],
        formats: ['a.pdf'],
        pdf: { paper: 'A5', landscape: true, mode: 'raster' },
      });
      await shell(`node ${CLI} record --pdf-margin=5mm`, metadata);
      const configured = parsePdf(await fs.readFile(path.join(dir.path, 'a.pdf')));
      await manifest({ inputs: ['a.html'], formats: ['a.pdf'], pdf: { paper: 'B9' } });
      const broken = await shellFails(`node ${CLI} record`, metadata);

      assert.true(
        configured.pages.every(
          ([, , width, height]) => Math.abs(width - 595.3) < 1 && Math.abs(height - 419.5) < 1,
        ),
        `A5, sideways, from package.json (${configured.pages})`,
      );
      assert.deepEqual(
        [configured.fonts, configured.jpegs > 0],
        [false, true],
        'its raster mode, kept beside the flag',
      );
      assert.includes(broken.stderr, 'package.json#qunitx.record.pdf: paper: expected one of fit');
    });
  },
);
