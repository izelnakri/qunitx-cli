import { module, test } from 'qunitx';
import { pageBreaks } from '../../lib/record/pdf-layout.ts';
import {
  encodable,
  nameFields,
  pdfName,
  pdfText,
  placeFields,
  textWidth,
  wrap,
  type PdfField,
} from '../../lib/record/pdf-fields.ts';
import type { LaidOutField } from '../../lib/record/pdf-layout.ts';
import {
  appendObjects,
  openPdf,
  parseValue,
  readObject,
  writeValue,
} from '../../lib/record/pdf-edit.ts';
import { fillPdf, slicePdf } from '../../lib/record/pdf-forms.ts';
import * as PDF from '../../lib/record/pdf.ts';
import { parsePdf } from '../helpers/pdf-parse.ts';
import '../helpers/custom-asserts.ts';

const laidOut = (overrides: Partial<LaidOutField>): LaidOutField => ({
  kind: 'text',
  name: 'field',
  value: '',
  checked: false,
  options: [],
  multiple: false,
  label: '',
  required: false,
  readOnly: false,
  maxLength: null,
  password: false,
  rect: { x: 0, y: 0, width: 100, height: 20 },
  font: { size: 16, color: [0, 0, 0], align: 'left' },
  padding: { left: 4, right: 4, top: 2 },
  action: null,
  ...overrides,
});

const placed = (overrides: Partial<PdfField>): Omit<PdfField, 'editable'> => {
  const { rect: _rect, font: _font, padding: _padding, ...rest } = laidOut({});
  return {
    ...rest,
    page: 0,
    rect: [10, 10, 110, 30],
    fontSize: 12,
    color: [0, 0, 0],
    align: 'left',
    padding: { left: 3, right: 3, top: 1.5 },
    ...overrides,
  };
};

// A PDF of one tall page with a link out and a link to a named destination further down, the
// way Chromium prints one: what slicing has to carry over.
function tallPdf(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Dests 6 0 R /Lang (en) >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 450 1500] /Resources << >> /Contents 7 0 R /Annots [4 0 R 5 0 R] >>',
    '<< /Type /Annot /Subtype /Link /Rect [6 1440 60 1452] /A << /S /URI /URI (https://example.com/) >> /StructParent 1 >>',
    '<< /Type /Annot /Subtype /Link /Rect [6 300 60 312] /Dest /end >>',
    '<< /end [3 0 R /XYZ 6 300 0] >>',
    '<< /Length 0 >>\nstream\n\nendstream',
    '<< /Title (Tall) >>',
  ];
  let text = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 8 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

module('Record | pdf | forms | page breaks', { concurrency: true }, () => {
  test('a page ends at the last point that cuts nothing, a forced break first, a too-tall block cut', (assert) => {
    assert.deepEqual(
      pageBreaks(250, 100, [], []),
      [0, 100, 200],
      'nothing in the way: every page full',
    );
    assert.deepEqual(
      pageBreaks(250, 100, [{ top: 90, bottom: 110 }], []),
      [0, 90, 190],
      'a line across the end moves to the next page',
    );
    assert.deepEqual(
      pageBreaks(
        300,
        100,
        [
          { top: 80, bottom: 120 },
          { top: 60, bottom: 85 },
        ],
        [],
      ),
      [0, 60, 160, 260],
      'moving up past one block can land in another: up past that too',
    );
    assert.deepEqual(
      pageBreaks(250, 100, [], [40]),
      [0, 40, 140, 240],
      'a forced break, where it is',
    );
    assert.deepEqual(
      pageBreaks(350, 100, [{ top: 0, bottom: 350 }], []),
      [0, 100, 200, 300],
      'a block taller than a page is cut where the page ends',
    );
    assert.deepEqual(
      pageBreaks(90, 100, [{ top: 10, bottom: 20 }], [0, 90]),
      [0],
      'all on one page',
    );
  });

  test('page ranges keep pages in order, each once, and none past the end', (assert) => {
    assert.deepEqual(PDF.keptPages('2-3, 1, 3', 4), [0, 1, 2]);
    assert.deepEqual(PDF.keptPages('3-9', 4), [2, 3]);
    assert.throws(() => PDF.keptPages('5', 4), /pageRanges 5: the PDF has 4 pages/);
  });
});

module('Record | pdf | forms | fields', { concurrency: true }, () => {
  test('a field goes on the page its top is on, in points from the bottom, scaled and inside the margin', (assert) => {
    const geometry = {
      starts: [0, 1000],
      pageHeight: 1000,
      paper: { width: 800, height: 1100 },
      margin: { top: 40, left: 20 },
      scale: 0.5,
    };
    const [first, second, cut] = placeFields(
      [
        laidOut({ rect: { x: 100, y: 200, width: 200, height: 40 } }),
        laidOut({ rect: { x: 0, y: 1100, width: 80, height: 20 } }),
        laidOut({ rect: { x: 0, y: 1900, width: 80, height: 400 } }),
      ],
      geometry,
    );

    assert.deepEqual(
      [first.page, first.rect, first.fontSize, first.padding],
      [0, [52.5, 705, 127.5, 720], 6, { left: 1.5, right: 1.5, top: 0.75 }],
      'page 1: left 20 + 100 × 0.5 = 70px = 52.5pt; top 40 + 200 × 0.5 = 140px down 1100px = 720pt up',
    );
    assert.deepEqual(
      [second.page, second.rect],
      [1, [15, 750, 45, 757.5]],
      'page 2, from its own start',
    );
    assert.equal(
      cut.rect[3] - cut.rect[1],
      37.5,
      'never past the end of its layout: 100px left × 0.5 × 0.75',
    );
  });

  test('names are unique: radio buttons a group, check boxes by value, the rest numbered, dots out', (assert) => {
    const named = nameFields([
      placed({ kind: 'radio', name: 'size', value: 's' }),
      placed({ kind: 'radio', name: 'size', value: 'm', checked: true }),
      placed({ kind: 'checkbox', name: 'topping', value: 'cheese' }),
      placed({ kind: 'checkbox', name: 'topping', value: 'ham.smoked' }),
      placed({ kind: 'checkbox', name: 'news', value: 'on' }),
      placed({ kind: 'text', name: 'line', value: '' }),
      placed({ kind: 'text', name: 'line', value: '' }),
      placed({ kind: 'text', name: 'user.email', value: '' }),
      placed({ kind: 'submit', name: '', value: 'Send' }),
      placed({ kind: 'checkbox', name: 'agree', value: 'on' }),
      placed({ kind: 'checkbox', name: 'agree', value: 'on' }),
      placed({ kind: 'text', name: 'size', value: '' }),
      placed({ kind: 'text', name: 'line[2]', value: '' }),
    ]);

    assert.deepEqual(
      named.map((field) => field.name),
      [
        'size',
        'size',
        'topping[cheese]',
        'topping[ham_smoked]',
        'news',
        'line',
        'line[2]',
        'user_email',
        'submit-9',
        'agree[on]',
        'agree[on][2]',
        'size[2]',
        'line[2][2]',
      ],
      'never two the same: not even a group by value, a radio group and a text, or a name like a number',
    );
  });

  test('only what Helvetica can write is editable: Latin text and labels; marks and buttons always', (assert) => {
    const named = nameFields([
      placed({ kind: 'text', name: 'a', value: 'Zoë Müller — “ok” €5' }),
      placed({ kind: 'text', name: 'b', value: '山田' }),
      placed({
        kind: 'select',
        name: 'c',
        options: [{ value: 'x', label: 'Ελληνικά', selected: true }],
      }),
      placed({ kind: 'checkbox', name: 'd', value: 'да' }),
    ]);

    assert.deepEqual(
      named.map((field) => field.editable),
      [true, false, false, true],
    );
    assert.true(encodable('tab\tand\nnewline'), 'white space is written as space');
    assert.false(encodable('emoji 🙂'));
  });

  test('text is measured in Helvetica and wrapped at spaces, through a word only when it must', (assert) => {
    assert.equal(textWidth('Hi', 10), 9.44, 'H 722 and i 222 thousandths');
    assert.equal(textWidth('é', 10), textWidth('e', 10), 'an accent takes its letter’s width');
    assert.deepEqual(wrap('one two three', 10, 40), ['one two', 'three']);
    assert.deepEqual(
      wrap('abcdefghij', 10, 20),
      ['abc', 'defg', 'hij'],
      'a word wider than the line, broken where it must',
    );
    assert.deepEqual(wrap('a\n\nb', 10, 100), ['a', '', 'b'], 'its own line breaks kept');
  });

  test('PDF strings and names: escaped ASCII, UTF-16 beyond it, names as UTF-8 bytes', (assert) => {
    assert.equal(pdfText('a (b) \\ c\n'), '(a \\(b\\) \\\\ c\\n)');
    assert.equal(pdfText('Zoë 🧾'), '<feff005a006f00eb0020d83eddfe>');
    assert.equal(pdfName('ham'), '/ham');
    assert.equal(pdfName('a b/é#'), '/a#20b#2F#C3#A9#23');
    assert.equal(pdfName(''), '/Yes', 'a state needs a name');
  });
});

module('Record | pdf | forms | edit', { concurrency: true }, () => {
  test('values read and write back the same; references, strings and nesting included', (assert) => {
    const source =
      '<< /Type /Annot /Rect [0 1.5 -2 .25] /A << /URI (a\\)b (c)) /D <feff00e9> >> /P 12 0 R /N null /B true >>';
    const value = parseValue(source);

    assert.equal(
      writeValue(value),
      '<< /Type /Annot /Rect [0 1.5 -2 0.25] /A << /URI (a\\)b (c)) /D <feff00e9> >> /P 12 0 R /N null /B true >>',
    );
    assert.deepEqual((value as Map<string, unknown>).get('P'), { ref: 12 });
    assert.deepEqual(
      parseValue('[1 2 3 0 R 4]'),
      [1, 2, { ref: 3 }, 4],
      'a number is a reference only with `0 R` after it',
    );
  });

  test('an update is appended: earlier objects kept, replaced ones read as replaced, every table valid', (assert) => {
    const original = PDF.encode([], { title: 'Before' });
    const file = openPdf(original);
    const updated = appendObjects(file, [
      { id: 3, body: '<< /Title (After) /Producer (qunitx record) >>' },
      { id: 4, body: '(new)' },
      { id: 6, body: '(gap)' },
    ]);
    const reopened = openPdf(updated);

    assert.deepEqual(updated.subarray(0, original.length), original, 'nothing before it rewritten');
    assert.equal(parsePdf(updated).title, 'After');
    assert.true(parsePdf(updated).xrefValid, 'both tables, each entry on its object');
    assert.deepEqual(readObject(reopened, 4), { string: '(new)' });
    assert.equal(reopened.size, 7);
    assert.equal(PDF.getTotalPageCount(updated), 0);
  });

  test('a cross-reference stream is refused, plainly', (assert) => {
    const pdf = new TextEncoder().encode(
      '%PDF-1.5\n1 0 obj\n<< /Type /XRef >>\nstream\nendstream\nendobj\nstartxref\n9\n%%EOF\n',
    );
    assert.throws(() => openPdf(pdf), /a cross-reference stream is not supported/);
  });
});

module('Record | pdf | forms | documents', { concurrency: true }, () => {
  const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 100, 0, 200, 3);

  test('fields on screenshot pages: each widget on its page, valued, flagged and drawn', (assert) => {
    const pages = [0, 1].map(() => ({
      jpeg,
      pixels: { width: 200, height: 100 },
      page: { width: 400, height: 300 },
      at: { x: 0, y: 0, width: 400, height: 200 },
    }));
    const fields = nameFields([
      placed({
        kind: 'text',
        name: 'email',
        value: 'ada@example.com',
        required: true,
        maxLength: 40,
      }),
      placed({ kind: 'textarea', name: 'bio', value: 'Zoë', page: 1 }),
      placed({ kind: 'text', name: 'pin', value: '1234', password: true, readOnly: true }),
      placed({
        kind: 'select',
        name: 'plan',
        options: [
          { value: 'free', label: 'Free', selected: false },
          { value: 'pro', label: 'Pro', selected: true },
        ],
      }),
      placed({
        kind: 'list',
        multiple: true,
        name: 'topics',
        options: [
          { value: 'a', label: 'A', selected: true },
          { value: 'b', label: 'B', selected: false },
          { value: 'c', label: 'C', selected: true },
        ],
      }),
      placed({ kind: 'checkbox', name: 'news', value: 'on', checked: true }),
      placed({ kind: 'radio', name: 'size', value: 's', page: 1 }),
      placed({ kind: 'radio', name: 'size', value: 'm', checked: true, page: 1 }),
      placed({
        kind: 'submit',
        name: 'go',
        action: { url: 'https://example.com/send', method: 'POST' },
      }),
      placed({ kind: 'submit', name: 'nowhere' }),
      placed({ kind: 'reset', name: 'clear', page: 1 }),
      placed({ kind: 'text', name: 'city', value: '東京' }),
    ]);
    const pdf = fillPdf(PDF.encode(pages, { title: 'Form' }), fields);
    const parsed = parsePdf(pdf);
    const text = new TextDecoder('latin1').decode(pdf);
    const by = (name: string) => parsed.fields.filter((field) => field.name === name);

    assert.true(parsed.xrefValid);
    assert.equal(parsed.pages.length, 2, 'the same pages, given widgets');
    assert.deepEqual(
      parsed.fields.map((field) => [field.name, field.type, field.page]),
      [
        ['email', 'Tx', 0],
        ['pin', 'Tx', 0],
        ['plan', 'Ch', 0],
        ['topics', 'Ch', 0],
        ['news', 'Btn', 0],
        ['go', 'Btn', 0],
        ['bio', 'Tx', 1],
        ['clear', 'Btn', 1],
        ['size', 'Btn', 1],
        ['size', 'Btn', 1],
      ],
      'on their pages; a submit with nowhere to go, and text Helvetica cannot write, left out',
    );
    assert.deepEqual(
      [by('email')[0].value, by('bio')[0].value, by('plan')[0].value, by('topics')[0].value],
      ['ada@example.com', 'Zoë', 'pro', 'a,c'],
    );
    assert.deepEqual(
      [
        by('email')[0].flags,
        by('pin')[0].flags,
        by('bio')[0].flags,
        by('plan')[0].flags,
        by('topics')[0].flags,
      ],
      [2, 1 | (1 << 13), 1 << 12, 1 << 17, 1 << 21],
      'required; read-only password; multiline; combo; multiple select',
    );
    assert.deepEqual(
      [by('news')[0].value, by('news')[0].states],
      ['Yes', ['Yes', 'Off']],
      'checked, with an off look',
    );
    assert.deepEqual(
      [by('size')[0].value, by('size').map((field) => field.states)],
      [
        'm',
        [
          ['s', 'Off'],
          ['m', 'Off'],
        ],
      ],
      'one radio group, its chosen button its value',
    );
    assert.includes(text, '/MaxLen 40');
    assert.includes(
      text,
      '/S /SubmitForm /F << /FS /URL /F (https://example.com/send) >> /Flags 4',
    );
    assert.includes(text, '/S /ResetForm');
    assert.includes(text, '/BaseFont /Helvetica /Encoding /WinAnsiEncoding');
    assert.includes(text, '(Zo\\353) Tj', "drawn in Helvetica's own encoding");
    assert.includes(text, '(\\225\\225\\225\\225) Tj', 'a password drawn as bullets');
  });

  test('nothing editable, nothing added', (assert) => {
    const pdf = PDF.encode([], { title: 'x' });
    assert.equal(fillPdf(pdf, nameFields([placed({ value: '山' })])), pdf);
  });

  test('a tall page sliced: pages of paper, each its part, links and destinations moved with it, an outline', (assert) => {
    const slicing = {
      starts: [0, 1000],
      pageHeight: 1000,
      height: 2000,
      keep: [0, 1],
      paper: { width: 700, height: 1100 },
      margin: { top: 50, left: 50 },
      scale: 1,
    };
    const fields = nameFields([
      placed({ name: 'late', value: 'x', page: 1, rect: [37.5, 700, 100, 720] }),
    ]);
    const pdf = slicePdf(tallPdf(), slicing, fields, [
      { level: 1, text: 'Top', top: 0 },
      { level: 2, text: 'Part', top: 10 },
      { level: 1, text: 'End', top: 1600 },
    ]);
    const parsed = parsePdf(pdf);
    const text = new TextDecoder('latin1').decode(pdf);

    assert.true(parsed.xrefValid);
    assert.deepEqual(
      parsed.pages,
      [
        [0, 0, 525, 825],
        [0, 0, 525, 825],
      ],
      'paper-sized, in points',
    );
    assert.equal(parsed.title, 'Tall');
    assert.deepEqual(
      parsed.links,
      [
        { page: 0, rect: [43.5, 727.5, 97.5, 739.5], to: 'https://example.com/' },
        { page: 1, rect: [43.5, 337.5, 97.5, 349.5], to: '#end' },
      ],
      'each on the page that shows it, 37.5pt of margin from its top and left',
    );
    assert.includes(text, '/end [', 'the destination moved too');
    assert.includes(text, '/XYZ 43.5 337.5 0]');
    assert.notIncludes(
      text.slice(tallPdf().length),
      'StructParent',
      'no tie to a structure tree that is gone',
    );
    assert.includes(
      text,
      'q 37.5 37.5 450 750 re W n 1 0 0 1 37.5 -712.5 cm',
      'page 1: its top 750pt, clipped',
    );
    assert.includes(
      text,
      'q 37.5 37.5 450 750 re W n 1 0 0 1 37.5 37.5 cm',
      'page 2: the next 750pt',
    );
    assert.deepEqual(parsed.outline, ['Top', 'Part', 'End']);
    assert.deepEqual(
      parsed.fields.map((field) => [field.name, field.page]),
      [['late', 1]],
    );
    assert.includes(text, '/Lang (en)', 'the catalog otherwise kept');
  });

  test('a page range keeps its pages: what is on the others, links and outline entries, left out', (assert) => {
    const slicing = {
      starts: [0, 1000],
      pageHeight: 1000,
      height: 2000,
      keep: [1],
      paper: { width: 600, height: 1000 },
      margin: { top: 0, left: 0 },
      scale: 1,
    };
    const parsed = parsePdf(
      slicePdf(
        tallPdf(),
        slicing,
        [],
        [
          { level: 1, text: 'Top', top: 0 },
          { level: 1, text: 'End', top: 1600 },
        ],
      ),
    );

    assert.equal(parsed.pages.length, 1);
    assert.deepEqual(
      parsed.links.map((link) => [link.page, link.to]),
      [[0, '#end']],
    );
    assert.deepEqual(parsed.outline, ['End']);
  });
});
