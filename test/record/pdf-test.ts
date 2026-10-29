import { module, test } from 'qunitx';
import * as CSS from '../../lib/record/css.ts';
import * as JPEG from '../../lib/record/jpeg.ts';
import * as PDF from '../../lib/record/pdf.ts';
import { invalidOptionReason } from '../../lib/record/options.ts';
import { parse } from '../../lib/commands/record/parse.ts';
import * as Failure from '../../lib/result/failure.ts';
import { parsePdf } from '../helpers/pdf-parse.ts';
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

module('Record | pdf | writer', { concurrency: true }, () => {
  test('a page a picture, in points, every object where the cross-reference table says', (assert) => {
    const pdf = PDF.encode(
      [
        {
          jpeg: jpeg(400, 300),
          pixels: { width: 400, height: 300 },
          page: { width: 400, height: 300 },
          at: { x: 0, y: 0, width: 400, height: 300 },
        },
        {
          jpeg: jpeg(200, 100),
          pixels: { width: 200, height: 100 },
          page: { width: 794, height: 1123 },
          at: { x: 48, y: 48, width: 698, height: 349 },
        },
      ],
      { title: 'Q4 (draft) \\ final' },
    );
    const parsed = parsePdf(pdf);
    const text = new TextDecoder('latin1').decode(pdf);

    assert.true(text.startsWith('%PDF-1.4'));
    assert.deepEqual(
      parsed.pages,
      [
        [0, 0, 300, 225],
        [0, 0, 595.5, 842.25],
      ],
      'CSS pixels as points: three quarters of each',
    );
    assert.equal(parsed.title, 'Q4 (draft) \\ final', 'parentheses and backslashes escaped');
    assert.equal(parsed.jpegs, 2);
    assert.false(parsed.fonts, 'pictures, no text');
    assert.true(parsed.xrefValid, 'every offset lands on its object');
    assert.includes(
      text,
      'q 523.5 0 0 261.75 36 544.5 cm /Im0 Do Q',
      'placed from the top-left, inside the margin',
    );
    assert.equal(PDF.getTotalPageCount(pdf), 2);
  });

  test('a title outside ASCII is UTF-16, which every reader shows', (assert) => {
    assert.equal(
      parsePdf(PDF.encode([], { title: 'Rechnung · 請求書 🧾' })).title,
      'Rechnung · 請求書 🧾',
    );
  });

  test('a JPEG is sized from its frame header; anything else is refused', (assert) => {
    assert.deepEqual(JPEG.getDimensions(jpeg(1280, 720)), { width: 1280, height: 720 });
    assert.throws(() => JPEG.getDimensions(Uint8Array.of(0xff, 0xd8, 0, 0)), /not a JPEG/);
  });

  test('lengths are CSS pixels, from px, in, cm, mm and pt', (assert) => {
    assert.deepEqual(
      [
        CSS.toPixels(12),
        CSS.toPixels('12'),
        CSS.toPixels('1in'),
        CSS.toPixels('2.54cm'),
        CSS.toPixels('25.4mm'),
        CSS.toPixels('72pt'),
      ],
      [12, 12, 96, 96, 96, 96],
    );
    assert.true(Number.isNaN(CSS.toPixels('1em')), 'nothing relative');
  });
});

module('Record | pdf | mode and settings', { concurrency: true }, () => {
  test('vector where the engine prints, raster elsewhere, and what only vector can do is named', (assert) => {
    assert.deepEqual(
      [
        PDF.getMode({}, 'chromium'),
        PDF.getMode({}, 'firefox'),
        PDF.getMode({ mode: 'raster' }, 'chromium'),
        PDF.getMode({ mode: 'vector' }, 'webkit'),
        PDF.getMode({ footer: '<span></span>' }, 'firefox'),
        PDF.getMode({ mode: 'raster', outline: true }, 'chromium'),
        PDF.getMode({ pageRanges: '1' }, 'chromium'),
      ].map((mode) => (PDF.UnprintablePdf.is(mode) ? mode.data.reason : mode)),
      [
        'vector',
        'raster',
        'raster',
        'mode vector needs chromium: webkit cannot print a page to PDF',
        'footer needs vector mode, which needs chromium',
        'outline needs vector mode; mode is raster',
        'vector',
      ],
    );
  });

  test('every setting is held to a rule, by name', (assert) => {
    assert.equal(
      invalidOptionReason('pdf', {
        mode: 'auto',
        paper: { width: '20cm', height: 600 },
        landscape: true,
        margin: { top: '1in', left: 8 },
        scale: 0.5,
        background: false,
        media: 'print',
        header: '<b></b>',
        footer: '',
        pageRanges: '1-3, 5',
        outline: true,
      }),
      null,
    );
    assert.deepEqual(
      [
        invalidOptionReason('pdf', 'A4'),
        invalidOptionReason('pdf', { paper: 'B9' }),
        invalidOptionReason('pdf', { paper: { width: '1em', height: 10 } }),
        invalidOptionReason('pdf', { margin: { middle: 1 } }),
        invalidOptionReason('pdf', { scale: 3 }),
        invalidOptionReason('pdf', { media: 'tv' }),
        invalidOptionReason('pdf', { pageRanges: 'odd' }),
        invalidOptionReason('pdf', { size: 'A4' }),
      ],
      [
        'expected an object of PDF settings, got "A4"',
        'paper: expected one of fit, Letter, Legal, Tabloid, Ledger, A0, A1, A2, A3, A4, A5, A6, got "B9"',
        'paper: expected a paper name or { width, height } in px, in, cm, mm or pt, got {"width":"1em","height":10}',
        'margin: expected a length, or { top, right, bottom, left } of lengths, got {"middle":1}',
        'scale: expected a number from 0.1 to 2, got 3',
        "media: expected 'screen' or 'print', got \"tv\"",
        'pageRanges: expected page ranges such as \'1-3, 5\', got "odd"',
        'has no setting size; expected mode, paper, margin, scale, media, header, footer, pageRanges, landscape, background, outline',
      ],
    );
  });

  test('the flags set the same settings: a paper size, a bare number as pixels, the switches', (assert) => {
    const parsed = parse(
      [
        'a.html',
        '--pdf-paper=20cmx800',
        '--pdf-margin',
        '12',
        '--pdf-landscape',
        '--no-pdf-background',
        '--pdf-outline',
        '--pdf-media=print',
        '--pdf-scale=0.9',
        '--pdf-pages=2',
        '--pdf-mode=vector',
      ],
      {},
    );
    const bad = parse(['a.html', '--pdf-scale=big'], {});

    assert.false(Failure.is(parsed));
    assert.deepEqual(!Failure.is(parsed) && parsed.options.pdf, {
      paper: { width: '20cm', height: 800 },
      margin: 12,
      landscape: true,
      background: false,
      outline: true,
      media: 'print',
      scale: 0.9,
      pageRanges: '2',
      mode: 'vector',
    });
    assert.true(Failure.is(bad));
    assert.includes((bad as Error).message, 'scale: expected a number from 0.1 to 2, got "big"');
  });
});
