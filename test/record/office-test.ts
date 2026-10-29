import { module, test } from 'qunitx';
import path from 'node:path';
import { zip } from '../../lib/record/zip.ts';
import { emu, hexColor, xml } from '../../lib/record/ooxml.ts';
import { writePptx, type OfficeStep } from '../../lib/record/pptx.ts';
import { writeDocx } from '../../lib/record/docx.ts';
import { plan } from '../../lib/record/outputs.ts';
import * as Failure from '../../lib/result/failure.ts';
import { balanced, unzip } from '../helpers/unzip.ts';
import '../helpers/custom-asserts.ts';

// The smallest JPEG that says its size: a start-of-image and a baseline frame header.
const jpeg = (width: number, height: number) =>
  Uint8Array.of(
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    3,
  );

const STEPS: OfficeStep[] = [
  {
    title: 'Sign in',
    caption: 'Fill in & "submit"',
    notes: 'Say who you are\nThen why',
    jpeg: jpeg(1280, 720),
  },
  { title: 'Ünïcode <done>', caption: null, notes: null, jpeg: jpeg(1280, 720) },
];

// The parts of a package by name, as text (pictures as their bytes' length).
function parts(archive: Uint8Array): Map<string, string> {
  return new Map(
    unzip(archive).map((entry) => [
      entry.name,
      entry.name.endsWith('.jpeg')
        ? `${entry.bytes.length} bytes`
        : new TextDecoder().decode(entry.bytes),
    ]),
  );
}

// Every relationship's target is a part, and every part has a content type: what an Office app
// checks before it opens a file at all.
function wellFormed(assert: Assert, files: Map<string, string>): void {
  const types = files.get('[Content_Types].xml')!;
  const defaults = [...types.matchAll(/Extension="(\w+)"/g)].map((match) => match[1]);
  const overrides = [...types.matchAll(/PartName="([^"]+)"/g)].map((match) => match[1].slice(1));
  for (const [name, text] of files) {
    if (name === '[Content_Types].xml') continue;
    assert.true(
      overrides.includes(name) || defaults.includes(name.split('.').pop()!),
      `${name} has a content type`,
    );
    if (name.endsWith('.xml') || name.endsWith('.rels'))
      assert.true(balanced(text), `${name} is well-formed`);
    if (!name.endsWith('.rels')) continue;
    const base = name.replace(/_rels\/[^/]*\.rels$/, '');
    for (const [, target] of text.matchAll(/Target="([^"]+)"/g)) {
      const resolved = new URL(target, `file:///${base}`).pathname.slice(1);
      assert.true(files.has(resolved), `${name} → ${resolved} exists`);
    }
  }
  for (const part of overrides) assert.true(files.has(part), `overridden ${part} exists`);
}

module('Record | office | zip', { concurrency: true }, () => {
  test('entries come back as written, deflated or stored, CRCs checked, UTF-8 names', (assert) => {
    const text = new TextEncoder().encode('<a>'.repeat(200));
    const picture = Uint8Array.from({ length: 300 }, (_, index) => index % 256);
    const archive = zip([
      { name: 'ppt/slides/slide1.xml', bytes: text },
      { name: 'media/çizim.jpeg', bytes: picture, stored: true },
      { name: 'empty', bytes: new Uint8Array(0) },
    ]);
    const entries = unzip(archive);

    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.bytes.length, entry.stored]),
      [
        ['ppt/slides/slide1.xml', 600, false],
        ['media/çizim.jpeg', 300, true],
        ['empty', 0, false],
      ],
    );
    assert.true(zip([{ name: 'a', bytes: text }]).length < 200, 'the XML deflated');
    assert.deepEqual(entries[1].bytes, picture);
    assert.deepEqual(
      zip([{ name: 'a', bytes: text }]),
      zip([{ name: 'a', bytes: text }]),
      'the same bytes every time',
    );
  });
});

module('Record | office | xml', { concurrency: true }, () => {
  test('text is escaped, characters XML cannot hold dropped; pixels as EMUs; colors as hex', (assert) => {
    assert.equal(
      xml('a & <b> "c" \u0007\u0000ok\ttab 🧾'),
      'a &amp; &lt;b&gt; &quot;c&quot; ok\ttab 🧾',
    );
    assert.deepEqual([emu(1), emu(96), emu(1280)], [9525, 914400, 12192000]);
    assert.deepEqual(
      [
        '#abc',
        '#5F3dc4',
        'rgb(1, 2, 300)',
        'rgba(0 128 255 / .5)',
        'linear-gradient(red, blue)',
        12,
      ].map((css) => hexColor(css, '11141C')),
      ['AABBCC', '5F3DC4', '0102FF', '0080FF', '11141C', '11141C'],
    );
  });
});

module('Record | office | pptx', { concurrency: true }, () => {
  test('a slide a step: its picture, a real title, the caption in the panel, notes as speaker notes', (assert) => {
    const files = parts(
      writePptx('Demo & co', STEPS, {
        canvas: { width: 1280, height: 720 },
        panel: { placement: 'below', height: 96, background: '#5f3dc4', color: 'white' },
      }),
    );
    const slide = files.get('ppt/slides/slide1.xml')!;

    wellFormed(assert, files);
    assert.includes(
      files.get('ppt/presentation.xml')!,
      '<p:sldSz cx="12192000" cy="7772400"/>',
      'canvas plus panel',
    );
    assert.equal(
      [...files.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length,
      2,
    );
    assert.includes(slide, '<p:ph type="title"/>');
    assert.includes(slide, '<a:t>Sign in</a:t>');
    assert.includes(slide, '<a:t>Fill in &amp; &quot;submit&quot;</a:t>', 'the caption, escaped');
    assert.includes(
      slide,
      'descr="Sign in: Fill in &amp; &quot;submit&quot;"',
      'the picture described',
    );
    assert.includes(
      slide,
      '<a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/>',
      'the picture fills the canvas',
    );
    assert.includes(slide, '<a:srgbClr val="5F3DC4"/>', "the panel's color");
    assert.includes(
      slide,
      '<a:srgbClr val="F1F3F5">',
      'a color that is no hex or rgb() falls back',
    );
    assert.includes(
      files.get('ppt/notesSlides/notesSlide1.xml')!,
      '<a:t>Say who you are</a:t></a:r></a:p><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>Then why</a:t>',
    );
    assert.includes(files.get('ppt/slides/slide2.xml')!, '<a:t>Ünïcode &lt;done&gt;</a:t>');
    assert.notIncludes(
      files.get('ppt/slides/slide2.xml')!,
      'name="Caption"',
      'no caption, no caption box',
    );
    assert.includes(files.get('docProps/core.xml')!, '<dc:title>Demo &amp; co</dc:title>');
  });

  test('the panel above moves the picture down; a slide is kept within PowerPoint’s 1 to 56 inches', (assert) => {
    const above = parts(
      writePptx('x', STEPS.slice(0, 1), {
        canvas: { width: 1280, height: 720 },
        panel: { placement: 'above', height: 96 },
      }),
    );
    const huge = parts(
      writePptx('x', [], {
        canvas: { width: 8000, height: 2000 },
        panel: { placement: 'below', height: 0 },
      }),
    );
    const tiny = parts(
      writePptx('x', [], {
        canvas: { width: 48, height: 24 },
        panel: { placement: 'below', height: 0 },
      }),
    );

    assert.includes(
      above.get('ppt/slides/slide1.xml')!,
      '<a:off x="0" y="914400"/><a:ext cx="12192000" cy="6858000"/>',
    );
    assert.includes(
      huge.get('ppt/presentation.xml')!,
      '<p:sldSz cx="51206400" cy="12801600"/>',
      '56in wide, its shape kept',
    );
    assert.includes(
      tiny.get('ppt/presentation.xml')!,
      '<p:sldSz cx="1828800" cy="914400"/>',
      '1in tall, its shape kept',
    );
    wellFormed(assert, huge);
  });
});

module('Record | office | docx', { concurrency: true }, () => {
  test('a title, then each step a heading, its picture fitted to the page, its caption and notes', (assert) => {
    const page = { width: 794, height: 1123, margin: { top: 96, right: 96, bottom: 96, left: 96 } };
    const files = parts(writeDocx('Demo', STEPS, page));
    const document = files.get('word/document.xml')!;
    const styles = files.get('word/styles.xml')!;

    wellFormed(assert, files);
    assert.deepEqual(
      [...document.matchAll(/<w:pStyle w:val="(\w+)"\/>/g)].map((match) => match[1]),
      ['Title', 'Heading1', 'Caption', 'Heading1'],
    );
    assert.includes(document, '<w:t xml:space="preserve">Fill in &amp; &quot;submit&quot;</w:t>');
    assert.includes(
      document,
      'Say who you are</w:t></w:r><w:r><w:br/></w:r><w:r><w:t xml:space="preserve">Then why',
      'notes keep their lines',
    );
    assert.includes(
      document,
      `<wp:extent cx="${emu(602)}" cy="${emu(338.625)}"/>`,
      '1280px shrunk to the 602px between the margins',
    );
    assert.includes(document, '<w:pgSz w:w="11910" w:h="16845"/>', 'the page, in twips');
    assert.includes(styles, '<w:name w:val="heading 1"/>', 'named as Word and Google Docs know it');
    assert.includes(styles, '<w:outlineLvl w:val="0"/>');
    assert.equal(files.get('word/media/image1.jpeg'), '12 bytes');
  });

  test('a tall picture fits the page’s height too; a wide page is landscape', (assert) => {
    const page = { width: 1123, height: 794, margin: { top: 0, right: 0, bottom: 0, left: 0 } };
    const document = parts(writeDocx('x', [{ ...STEPS[1], jpeg: jpeg(450, 2000) }], page)).get(
      'word/document.xml',
    )!;
    const height = Math.round(794 * 0.72 * 100) / 100;

    assert.includes(document, `cy="${emu(height)}"`, 'its height, the page’s share');
    assert.includes(document, 'w:orient="landscape"');
  });
});

module('Record | office | outputs', { concurrency: true }, () => {
  test('pptx and docx are one file of every input, named after it or the recording', (assert) => {
    const pages = [
      { kind: 'url' as const, source: 'https://a.com', url: 'https://a.com', name: 'a.com' },
      { kind: 'url' as const, source: 'https://b.com', url: 'https://b.com', name: 'b.com' },
    ];
    const outputs = plan(['pptx', 'notes.docx', 'jpg'], pages, '/out');
    const unknown = plan(['keynote'], pages, '/out');

    assert.false(Failure.is(outputs));
    assert.deepEqual(
      !Failure.is(outputs) &&
        outputs.map((output) => [output.format, output.absolutePath, output.inputIndex]),
      [
        ['pptx', path.resolve('/out/recording.pptx'), null],
        ['docx', path.resolve('/out/notes.docx'), null],
        ['jpeg', path.resolve('/out/a.com.jpg'), 0],
        ['jpeg', path.resolve('/out/b.com.jpg'), 1],
      ],
    );
    assert.includes(
      (unknown as Error).message,
      'Expected png, jpg, gif, webm, mp4, html, pdf, pptx or docx',
    );
  });
});
