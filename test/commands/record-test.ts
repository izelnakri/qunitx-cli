import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import * as PNG from '../../lib/record/png.ts';
import { LAYOUT } from '../../lib/record/diff.ts';
import { execute as shell, shellFails } from '../helpers/shell.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import { decodeGif } from '../helpers/gif-decode.ts';
import { parseMp4, parseWebM } from '../helpers/video-parse.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parsePdf } from '../helpers/pdf-parse.ts';
import { unzip } from '../helpers/unzip.ts';
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
        "expected true, or one or a list of 'html', 'pdf', 'xlsx', 'csv', 'tsv', got \"xml\"",
      );
    });

    test('--report=xlsx,csv,tsv writes a workbook and rows for scripts, and no page unless asked', async (assert, testMetadata) => {
      await using dir = await tempDir('record-report-sheets');
      const metadata = { ...moduleMetadata, ...testMetadata, cwd: dir.path };
      await fs.writeFile(path.join(dir.path, 'a.html'), page('rgb(0,0,255)'));
      await fs.writeFile(path.join(dir.path, 'b.html'), page('rgb(0,255,0)'));
      await shell(`node ${CLI} record a.html b.html -w 40 -h 30 -o shots --compare`, metadata);
      await fs.writeFile(path.join(dir.path, 'a.html'), page('rgb(255,0,0)'));
      const result = await shell(
        `node ${CLI} record a.html b.html -w 40 -h 30 -o shots --report=xlsx,csv,tsv`,
        metadata,
      ).catch((error) => error);
      const read = (name: string) => fs.readFile(path.join(dir.path, 'shots', name));
      const workbook = new Map(
        unzip(await read('report.xlsx')).map((entry) => [
          entry.name,
          new TextDecoder().decode(entry.bytes),
        ]),
      );
      const csv = new TextDecoder().decode(await read('report.csv'));

      for (const name of ['report.xlsx', 'report.csv', 'report.tsv']) {
        assert.includes(result.stdout, `${path.join('shots', name)}  report`);
      }
      assert.deepEqual(
        csv
          .split('\n')
          .slice(1, 3)
          .map((line) => line.split(',').slice(0, 2)),
        [
          ['a.png', 'changed'],
          ['b.png', 'unchanged'],
        ],
      );
      assert.includes(workbook.get('xl/worksheets/sheet1.xml')!, '>a.png</t>');
      assert.includes(
        workbook.get('xl/worksheets/_rels/sheet1.xml.rels')!,
        'Target="a.diff.png" TargetMode="External"',
      );
      assert.includes(new TextDecoder().decode(await read('report.tsv')), 'a.png\tchanged\t');
      assert.false(
        await fs.stat(path.join(dir.path, 'shots', 'report.html')).then(
          () => true,
          () => false,
        ),
        'no report.html unless asked for',
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
