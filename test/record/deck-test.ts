import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canvasOf } from '../../lib/record/deck.ts';
import { filledPanelHTML } from '../../lib/record/panel.ts';
import { parseSlides, slidePage, imageSlide } from '../../lib/record/slides.ts';
import { DEFAULT_PLAYER, renderPlayer, type PlayerFrame } from '../../lib/record/player.ts';
import { invalidOptionReason } from '../../lib/record/options.ts';
import { Timeline } from '../../lib/record/tour/timeline.ts';
import * as Inputs from '../../lib/record/inputs.ts';
import * as Outputs from '../../lib/record/outputs.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

const jpeg = (byte: number) => Uint8Array.of(255, 216, 255, byte);
const tabs = { titles: [''], active: 0, url: '' };

module('Record | deck | steps', { concurrency: true }, () => {
  test('a step named before any frame names the first; later ones start new steps', (assert) => {
    const timeline = new Timeline({ width: 800, height: 600 }, 10, tabs);
    assert.deepEqual(timeline.steps, [{ title: null, notes: null }], 'one, untitled, to begin');
    timeline.step('Sign in');
    timeline.hold(300);
    timeline.step('Pay', 'Validated as you type.');
    timeline.hold(300);
    timeline.step('Done');
    timeline.step('Really done');

    assert.deepEqual(
      timeline.steps.map((step) => step.title),
      ['Sign in', 'Pay', 'Really done'],
      'an empty step is renamed, not left empty',
    );
    assert.deepEqual(
      timeline.beats.map((beat) => beat.step),
      [0, 1],
    );
    assert.equal(timeline.steps[1].notes, 'Validated as you type.');
  });

  test('parts of different sizes share the biggest canvas', (assert) => {
    assert.deepEqual(
      canvasOf([
        { width: 450, height: 948 },
        { width: 1280, height: 794 },
        { width: 1280, height: 720 },
      ]),
      { width: 1280, height: 948 },
    );
  });
});

module('Record | deck | slides', { concurrency: true }, () => {
  test('a deck splits on --- lines; titles come from headings, notes from Note:', async (assert) => {
    const slides = await parseSlides(
      [
        '# **Acme** [Shop](https://acme.test)',
        'Intro text',
        '---',
        '## Plan',
        '| step | time |\n| --- | --- |\n| pay | 1s |',
        '- [x] done',
        'Note: keep it short',
        'and friendly',
        '------',
        'No heading here',
        '---',
        '   ',
      ].join('\n\n'),
    );

    assert.deepEqual(
      slides.map((slide) => [slide.title, slide.notes]),
      [
        ['Acme Shop', null],
        ['Plan', 'keep it short\n\nand friendly'],
        ['Slide 3', null],
      ],
      'empty parts are not slides',
    );
    assert.includes(slides[1].html, '<table>');
    assert.includes(slides[1].html, 'type="checkbox"');
    assert.false(slides[1].html.includes('keep it short'), 'notes are never on the slide');
  });

  test("a slide page lays the recording's css and the slide's style over the defaults, escaped", (assert) => {
    const page = slidePage('<h1>Hi</h1>', {
      css: '.slide h1 { color: red; }',
      style: { background: '#000', fontFamily: '"Inter"' },
    });

    assert.true(
      page.indexOf('.slide h1 {') < page.indexOf('.slide h1 { color: red; }'),
      'css after the defaults',
    );
    assert.includes(page, 'style="background: #000; font-family: &quot;Inter&quot;"');
    assert.equal(imageSlide('a"b.png', '<x>'), '<img src="a&quot;b.png" alt="&lt;x>">');
  });

  test('.md and .markdown are decks, pictures are slides, a URL to a picture too', async (assert) => {
    await using dir = await tempDir('deck-inputs');
    await Promise.all(
      ['talk.md', 'notes.markdown', 'chart.png', 'photo.jpeg', 'logo.svg'].map((file) =>
        fs.writeFile(path.join(dir.path, file), ''),
      ),
    );
    const inputs = await Inputs.resolve(
      [
        'talk.md',
        'notes.markdown',
        'chart.png',
        'photo.jpeg',
        'logo.svg',
        'https://cdn.test/a/hero.webp',
      ],
      dir.path,
    );

    assert.deepEqual(
      inputs.map((input) => [input.kind, input.name]),
      [
        ['slides', 'talk'],
        ['slides', 'notes'],
        ['image', 'chart'],
        ['image', 'photo'],
        ['image', 'logo'],
        ['image', 'cdn.test-a-hero.webp'],
      ],
    );
  });

  test('html is one output of every input, like gif, named after a single input', async (assert) => {
    const [deck, tour] = await Promise.all([
      Inputs.resolve(['https://a.test/', 'https://b.test/'], '/'),
      Inputs.resolve(['https://a.test/'], '/'),
    ]);
    const plan = (entries: string[], inputs: Inputs.Input[]) =>
      (Outputs.plan(entries, inputs, '/out') as Outputs.Output[]).map((output) => [
        output.format,
        output.absolutePath,
        output.inputIndex,
      ]);

    assert.deepEqual(plan(['html'], deck), [['html', path.resolve('/out/recording.html'), null]]);
    assert.deepEqual(
      (Outputs.plan(['deck.pdf'], deck, '/out', true) as Outputs.Output[]).map((output) => [
        output.absolutePath,
        output.inputIndex,
      ]),
      [[path.resolve('/out/deck.pdf'), null]],
      'a recording of steps prints as one PDF',
    );
    assert.deepEqual(
      (Outputs.plan(['pdf'], deck, '/out') as Outputs.Output[]).map(
        (output) => output.absolutePath,
      ),
      [path.resolve('/out/a.test.pdf'), path.resolve('/out/b.test.pdf')],
      'pages alone, a PDF each',
    );
    assert.deepEqual(plan(['html', 'demo.gif'], tour), [
      ['html', path.resolve('/out/a.test.html'), null],
      ['gif', path.resolve('/out/demo.gif'), null],
    ]);
  });
});

module('Record | deck | player', { concurrency: true }, () => {
  const steps = [
    { title: 'One', notes: null },
    { title: 'Two </script><b>', notes: 'n' },
  ];
  const frames: PlayerFrame[] = [
    { image: jpeg(1), durationMs: 100, step: 0, caption: null },
    { image: jpeg(1), durationMs: 100, step: 0, caption: null },
    { image: jpeg(2), durationMs: 250.4, step: 1, caption: 'Pay' },
  ];
  const render = (overrides: Partial<Parameters<typeof renderPlayer>[0]> = {}) =>
    renderPlayer({
      title: 'Demo <1>',
      size: { width: 640, height: 360 },
      steps,
      frames,
      panel: { placement: 'below', height: 96, style: { background: '#123456' } },
      css: '#panel { color: red; } </style><script>alert(1)</script>',
      player: DEFAULT_PLAYER,
      assetsDir: 'demo-files',
      ...overrides,
    });
  const dataOf = (html: string) =>
    JSON.parse(
      html.slice(
        html.indexOf('id="recording">') + 15,
        html.indexOf('</script>', html.indexOf('id="recording">')),
      ),
    );

  test('identical pictures are kept once; inline as data URLs, or as files beside the page', (assert) => {
    const inline = render();
    const split = render({ player: { ...DEFAULT_PLAYER, assets: 'files' } });

    assert.equal(dataOf(inline.html).images.length, 2, 'three frames, two pictures');
    assert.true(
      dataOf(inline.html).images.every((src: string) => src.startsWith('data:image/jpeg;base64,')),
    );
    assert.deepEqual(inline.files, []);
    assert.deepEqual(dataOf(split.html).images, [
      'demo-files/frame-0001.jpg',
      'demo-files/frame-0002.jpg',
    ]);
    assert.deepEqual(
      split.files.map((file) => file.name),
      ['frame-0001.jpg', 'frame-0002.jpg'],
    );
    assert.deepEqual(dataOf(inline.html).frames, [
      { i: 0, d: 100, s: 0, c: null },
      { i: 0, d: 100, s: 0, c: null },
      { i: 1, d: 250, s: 1, c: 'Pay' },
    ]);
  });

  test('text from the recording cannot end its script or style, and the panel goes where asked', (assert) => {
    const below = render();
    const above = render({ panel: { placement: 'above', height: 120, style: {} } });

    assert.false(below.html.includes('</style><script>alert(1)'), 'its css cannot end its <style>');
    assert.includes(below.html, '<title>Demo &lt;1></title>');
    assert.includes(below.html, '<\\/style><script>alert(1)');
    assert.includes(below.html, 'id="panel" style="background: #123456"');
    assert.true(
      below.html.indexOf('id="viewport"') < below.html.indexOf('id="panel"'),
      'below the frame',
    );
    assert.true(above.html.indexOf('id="panel"') < above.html.indexOf('id="viewport"'), 'above it');
    assert.includes(above.html, '#panel { min-height: 120px; }');
  });
});

module('Record | deck | printed panel', { concurrency: true }, () => {
  test('a printed step has its panel filled in: its title, caption and notes, escaped, its mark lit', (assert) => {
    const html = filledPanelHTML(['One', 'Two <b>'], 1, 'Pay & go', 'why "now"');

    assert.includes(html, '<div class="title">Two &lt;b></div>');
    assert.includes(html, '<div class="caption">Pay &amp; go</div>');
    assert.includes(html, '<div class="notes">why &quot;now&quot;</div>');
    assert.equal(html.match(/class="step active"/g)!.length, 1);
    assert.true(html.indexOf('step active') > html.indexOf('title="One"'), 'the second lit');
  });
});

module('Record | deck | options', { concurrency: true }, () => {
  test('panel, slide, player, css and backdrop are held to rules, each field by name', (assert) => {
    assert.equal(
      invalidOptionReason('panel', { placement: 'above', height: 120, style: { color: '#fff' } }),
      null,
    );
    assert.equal(
      invalidOptionReason('player', {
        advance: 'auto',
        loop: true,
        autoplay: false,
        assets: 'files',
      }),
      null,
    );
    assert.deepEqual(
      [
        invalidOptionReason('panel', 'above'),
        invalidOptionReason('panel', { placement: 'left' }),
        invalidOptionReason('panel', { height: 4 }),
        invalidOptionReason('panel', { side: 'left' }),
        invalidOptionReason('slide', { style: 'red' }),
        invalidOptionReason('player', { advance: 'never' }),
        invalidOptionReason('player', { loop: 'yes' }),
        invalidOptionReason('css', 42),
        invalidOptionReason('backdrop', ' '),
      ],
      [
        'expected an object of placement, height, style, got "above"',
        "placement: expected 'above' or 'below', got \"left\"",
        'height: expected a whole number of pixels from 24 to 600, got 4',
        'has no setting side; expected placement, height, style',
        'style: expected an object of CSS declarations, got "red"',
        "advance: expected 'auto' or 'click', got \"never\"",
        'loop: expected true or false, got "yes"',
        'expected a stylesheet, got 42',
        'expected a CSS background, got " "',
      ],
    );
  });
});
