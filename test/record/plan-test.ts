import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as Inputs from '../../lib/record/inputs.ts';
import * as Outputs from '../../lib/record/outputs.ts';
import { InvalidRecordArgument, parse as parseWithEnv } from '../../lib/commands/record/parse.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';
import type { Input } from '../../lib/record/inputs.ts';

// An empty environment unless a test passes one, so a QUNITX_BROWSER in the shell running the
// suite cannot leak into what these parse.
const parse = (argv: string[], env: Record<string, string> = {}) => parseWithEnv(argv, env);
const urlInput = (name: string): Input => ({
  kind: 'url',
  source: name,
  url: `https://${name}`,
  name,
});
const scriptInput = (name: string): Input => ({
  kind: 'script',
  source: `${name}.ts`,
  path: `/p/${name}.ts`,
  name,
});
const paths = (outputs: ReturnType<typeof Outputs.plan>) =>
  Outputs.UnknownFormat.is(outputs)
    ? outputs.message
    : outputs.map((output) => path.basename(output.absolutePath));

module('Record | inputs', { concurrency: true }, () => {
  test('URLs are pages unless they name a script; paths are classified by what is on disk', async (assert) => {
    await using dir = await tempDir('record-inputs');
    const root = dir.path;
    await fs.mkdir(path.join(root, 'site'));
    await fs.mkdir(path.join(root, 'empty'));
    await Promise.all([
      fs.writeFile(path.join(root, 'site', 'index.html'), '<p>hi</p>'),
      fs.writeFile(path.join(root, 'home.html'), '<p>home</p>'),
      fs.writeFile(path.join(root, 'demo.tsx'), 'export {};'),
      fs.writeFile(path.join(root, 'notes.txt'), ''),
    ]);

    const inputs = await Inputs.resolve(
      ['https://example.com/a', 'http://cdn.test/seed.ts', 'site', 'home.html', 'demo.tsx'],
      root,
    );

    assert.deepEqual(
      inputs.map((input) => [input.kind, input.name]),
      [
        ['url', 'example.com-a'],
        ['script', 'cdn.test-seed.ts'],
        ['html', 'site'],
        ['html', 'home'],
        ['script', 'demo'],
      ],
    );
    assert.equal(
      inputs[2].kind === 'html' && inputs[2].root,
      path.join(root, 'site'),
      'served from its own directory',
    );
    await assert.rejects(
      Inputs.resolve(['nope.html'], root),
      /cannot record nope\.html: no such file/,
    );
    await assert.rejects(Inputs.resolve(['empty'], root), /a directory with no index\.html/);
    await assert.rejects(Inputs.resolve(['notes.txt'], root), /not an \.html page, a URL, or a/);
  });

  test('a file:// URL is the file it names', async (assert) => {
    await using dir = await tempDir('record-file-url');
    const file = path.join(dir.path, 'a page.html');
    await fs.writeFile(file, '');

    const [input] = await Inputs.resolve(
      [new URL(`file://${file.split(path.sep).join('/').replace(/^\/?/, '/')}`).href],
      '/',
    );

    assert.equal(input.kind === 'html' && input.path, file);
  });

  test('a served file keeps its path below the root, escaped', (assert) => {
    assert.equal(
      Inputs.getFullURLOf(
        path.join('/', 'site', 'docs', 'a b.html'),
        'http://localhost:4000',
        path.join('/', 'site'),
      ),
      'http://localhost:4000/docs/a%20b.html',
    );
  });
});

module('Record | outputs', { concurrency: true }, () => {
  test('one page defaults to a jpg; several inputs, or a script, add one gif of them all', (assert) => {
    assert.deepEqual(paths(Outputs.plan([], [urlInput('a.com')], '/out')), ['a.com.jpg']);
    assert.deepEqual(paths(Outputs.plan([], [urlInput('a.com'), urlInput('b.com')], '/out')), [
      'a.com.jpg',
      'b.com.jpg',
      'recording.gif',
    ]);
    assert.deepEqual(paths(Outputs.plan([], [scriptInput('demo')], '/out')), [
      'demo.jpg',
      'demo.gif',
    ]);
  });

  test('-f narrows to one format, names files, and numbers stills of several inputs', (assert) => {
    const two = [urlInput('a.com'), urlInput('b.com')];

    assert.deepEqual(paths(Outputs.plan(['gif'], two, '/out')), ['recording.gif']);
    assert.deepEqual(paths(Outputs.plan(['shot.png', 'all.gif'], two, '/out')), [
      'shot-1.png',
      'shot-2.png',
      'all.gif',
    ]);
    assert.deepEqual(paths(Outputs.plan(['JPEG', 'a.GIF'], [urlInput('a.com')], '/out')), [
      'a.com.jpg',
      'a.GIF',
    ]);
  });

  test('inputs that share a name do not overwrite each other', (assert) => {
    assert.deepEqual(paths(Outputs.plan(['png'], [urlInput('a.com'), urlInput('a.com')], '/out')), [
      'a.com.png',
      'a.com-2.png',
    ]);
  });

  test('paths are relative to the output directory, subdirectories included', (assert) => {
    const outputs = Outputs.plan(['shots/home.png'], [urlInput('a.com')], path.resolve('/out'));

    assert.equal(
      !Outputs.UnknownFormat.is(outputs) && outputs[0].absolutePath,
      path.resolve('/out/shots/home.png'),
    );
  });

  test('anything else is an unknown format', (assert) => {
    assert.includes(
      paths(Outputs.plan(['bmp'], [urlInput('a.com')], '/out')),
      'unknown format: bmp',
    );
    assert.includes(
      paths(Outputs.plan(['.gif'], [urlInput('a.com')], '/out')),
      'unknown format: .gif',
    );
  });

  test('-f values split on commas, and a trailing comma continues into the next value', (assert) => {
    assert.deepEqual(Outputs.splitEntries(['a.gif, a.jpg', 'png,']), ['a.gif', 'a.jpg', 'png']);
  });
});

module('Record | parse', { concurrency: true }, () => {
  test('-f, -w, -h and -o are format, width, height and output, in either spelling', (assert) => {
    const parsed = parse([
      'http://a.com',
      '-f',
      'some-name.gif,',
      'some-name.jpg',
      '-w',
      '1200',
      '--height=900',
      '-o',
      'shots',
    ]);

    assert.deepEqual(parsed, {
      help: false,
      sources: ['http://a.com'],
      options: {
        formats: ['some-name.gif', 'some-name.jpg'],
        width: 1200,
        height: 900,
        output: 'shots',
      },
    });
  });

  test('every other flag lands on its option', (assert) => {
    const parsed = parse([
      'a.html',
      'b.html',
      '--scale=2',
      '--full-page',
      '--wait-for',
      '#ready',
      '--page-duration=1500',
      '--last-frame-duration=0',
      '--fps',
      '25',
      '--quality=70',
      '--browser=webkit',
      '--timeout=5000',
      '-p',
      '4000',
      '--format=png',
      '--',
      '-odd-name.html',
    ]);

    assert.deepEqual(parsed, {
      help: false,
      sources: ['a.html', 'b.html', '-odd-name.html'],
      options: {
        scale: 2,
        fullPage: true,
        waitFor: '#ready',
        pageDuration: 1500,
        lastFrameDuration: 0,
        fps: 25,
        quality: 70,
        browser: 'webkit',
        timeout: 5000,
        port: 4000,
        formats: ['png'],
      },
    });
    assert.deepEqual(parse(['--wait-for=250']), {
      help: false,
      sources: [],
      options: { waitFor: 250 },
    });
  });

  test('a glob of tens of thousands of inputs is read in one pass, without running out of stack', (assert) => {
    const inputs = Array.from({ length: 50_000 }, (_input, index) => `page-${index}.html`);
    const parsed = parse([...inputs, '-f', 'png'], {});

    assert.false(InvalidRecordArgument.is(parsed));
    assert.deepEqual(
      [parsed.sources.length, parsed.sources.at(-1), parsed.options.formats],
      [50_000, 'page-49999.html', ['png']],
    );
  });

  test('QUNITX_BROWSER is the default engine, as for a test run; --browser wins over it', (assert) => {
    const browserOf = (argv: string[], env: Record<string, string>) => {
      const parsed = parse(argv, env);
      return InvalidRecordArgument.is(parsed) ? parsed.message : parsed.options.browser;
    };

    assert.equal(browserOf(['a.html'], { QUNITX_BROWSER: 'webkit' }), 'webkit');
    assert.equal(
      browserOf(['a.html', '--browser=firefox'], { QUNITX_BROWSER: 'webkit' }),
      'firefox',
    );
    assert.equal(browserOf(['a.html'], {}), undefined);
    assert.includes(
      String(browserOf(['a.html'], { QUNITX_BROWSER: 'ie' })),
      'QUNITX_BROWSER: expected one of',
    );
  });

  test('a bad value or an unknown flag says which, and why', (assert) => {
    const message = (argv: string[]) => {
      const parsed = parse(argv);
      return InvalidRecordArgument.is(parsed) ? parsed.message : 'parsed';
    };

    assert.includes(
      message(['-w', 'wide']),
      '-w: expected a whole number of pixels from 1 to 16384, got "wide"',
    );
    assert.includes(message(['-h', '0']), '-h: expected a whole number of pixels');
    assert.includes(message(['--fps=60']), '--fps: expected a whole number from 1 to 50');
    assert.includes(
      message(['--browser=ie']),
      '--browser: expected one of chromium, firefox, webkit',
    );
    assert.includes(message(['--scale=0']), '--scale: expected a number above 0');
    assert.includes(message(['--watch']), '--watch: unknown flag');
    assert.includes(message(['-f']), '-f: needs a value');
    assert.equal(message(['--help']), 'parsed');
  });
});
