import { module, test } from 'qunitx';
import { column, writeXlsx } from '../../lib/record/xlsx.ts';
import { delimited, sheets, type ReportEntry } from '../../lib/record/report.ts';
import { balanced, unzip } from '../helpers/unzip.ts';
import '../helpers/custom-asserts.ts';

const comparison = (status: 'new' | 'unchanged' | 'changed' | 'updated', changedPixels = 0) => ({
  status,
  changedPixels,
  totalPixels: 400,
  diffPath: status === 'changed' ? '/shots/sub dir/b.diff.png' : null,
  currentPath: status === 'changed' ? '/shots/sub dir/b.new.png' : null,
});
const ENTRIES: ReportEntry[] = [
  { path: '/shots/z.png', width: 20, height: 20, comparison: comparison('unchanged') },
  { path: '/shots/sub dir/b.png', width: 20, height: 20, comparison: comparison('changed', 37) },
  { path: '/shots/a,"quoted".png', width: 20, height: 20, comparison: comparison('new') },
];

function parts(archive: Uint8Array): Map<string, string> {
  return new Map(
    unzip(archive).map((entry) => [entry.name, new TextDecoder().decode(entry.bytes)]),
  );
}

module('Record | sheets | xlsx', { concurrency: true }, () => {
  test('a workbook: a tab a sheet, typed and styled cells, a frozen header, filters, links out', (assert) => {
    const files = parts(
      writeXlsx('Q & A', [
        {
          name: 'Runs: 2026/10?',
          columns: [
            { header: 'Name', width: 20 },
            { header: 'Share', width: 10 },
            { header: 'File', width: 10 },
          ],
          rows: [
            [
              '<home>',
              { value: 0.125, look: 'percent' },
              { value: 'open', link: 'sub dir/a b.png' },
            ],
            [
              null,
              { value: 3, formula: 'SUM(1,2)', look: 'strong' },
              { value: 1234, look: 'count' },
            ],
          ],
        },
        { name: '', columns: [], rows: [] },
      ]),
    );
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    const types = files.get('[Content_Types].xml')!;

    for (const [name, text] of files) assert.true(balanced(text), `${name} is well-formed`);
    for (const part of [...types.matchAll(/PartName="\/([^"]+)"/g)].map((match) => match[1])) {
      assert.true(files.has(part), `${part} is in the package`);
    }
    assert.includes(
      files.get('xl/workbook.xml')!,
      '<sheet name="Runs  2026 10" sheetId="1" r:id="rId1"/><sheet name="Sheet2" sheetId="2" r:id="rId2"/>',
      'tab names Excel accepts: no `:/?`, and never empty',
    );
    assert.includes(
      files.get('xl/workbook.xml')!,
      `'Runs  2026 10'!$A$1:$C$3</definedName>`,
      "the filter's range",
    );
    assert.includes(
      sheet,
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    );
    assert.includes(sheet, '<autoFilter ref="A1:C3"/>');
    assert.includes(
      sheet,
      '<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Name</t></is></c>',
      'a styled header',
    );
    assert.includes(
      sheet,
      '<c r="A2" t="inlineStr"><is><t xml:space="preserve">&lt;home&gt;</t></is></c>',
    );
    assert.includes(sheet, '<c r="B2" s="3"><v>0.125</v></c>', 'a fraction, shown as a percentage');
    assert.includes(
      sheet,
      '<c r="B3" s="5"><f>SUM(1,2)</f><v>3</v></c>',
      'a formula, and its value until recalculated',
    );
    assert.includes(sheet, '<c r="C3" s="2"><v>1234</v></c>');
    assert.notIncludes(sheet, 'r="A3"', 'an empty cell is left out');
    assert.includes(sheet, '<hyperlink ref="C2" r:id="rId1"/>');
    assert.includes(
      files.get('xl/worksheets/_rels/sheet1.xml.rels')!,
      'Target="sub dir/a b.png" TargetMode="External"',
      'a link to a file beside the workbook',
    );
    assert.includes(files.get('xl/styles.xml')!, 'formatCode="0.00%"');
    assert.includes(files.get('docProps/core.xml')!, '<dc:title>Q &amp; A</dc:title>');
  });

  test('columns are lettered as spreadsheets letter them', (assert) => {
    assert.deepEqual([0, 1, 25, 26, 27, 51, 52, 701, 702, 16383].map(column), [
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
      'XFD',
    ]);
  });
});

module('Record | sheets | report', { concurrency: true }, () => {
  test('a row a snapshot, changed first, its share as a fraction, its files linked; a summary that totals', (assert) => {
    const [snapshots, summary] = sheets(ENTRIES, { directory: '/shots' });

    assert.deepEqual(
      snapshots.rows.map((row) => row.slice(0, 5)),
      [
        [
          'sub dir/b.png',
          { value: 'changed', look: 'red' },
          { value: 37, look: 'count' },
          { value: 400, look: 'count' },
          { value: 0.0925, look: 'percent' },
        ],
        [
          'a,"quoted".png',
          { value: 'new', look: 'blue' },
          { value: 0, look: 'count' },
          { value: 400, look: 'count' },
          { value: 0, look: 'percent' },
        ],
        [
          'z.png',
          { value: 'unchanged', look: 'green' },
          { value: 0, look: 'count' },
          { value: 400, look: 'count' },
          { value: 0, look: 'percent' },
        ],
      ],
    );
    assert.deepEqual(snapshots.rows[0].slice(7), [
      { value: 'baseline', link: 'sub%20dir/b.png' },
      { value: 'new', link: 'sub%20dir/b.new.png' },
      { value: 'diff', link: 'sub%20dir/b.diff.png' },
    ]);
    assert.deepEqual(
      snapshots.rows[1].slice(8),
      [null, null],
      'no new screenshot or diff, no link',
    );
    assert.deepEqual(summary.rows.at(-1), [
      { value: 'total', look: 'strong' },
      { value: 3, look: 'strong', formula: 'SUM(B2:B5)' },
    ]);
    assert.deepEqual(
      summary.rows.slice(0, 4).map((row) => row[1]),
      [1, 1, 0, 1],
    );
  });

  test('CSV quotes what it must; TSV, which cannot quote, has no tabs inside a field', (assert) => {
    const csv = delimited(ENTRIES, { directory: '/shots' }, ',');
    const tsv = delimited(
      [{ ...ENTRIES[0], path: '/shots/tab\there.png' }],
      { directory: '/shots' },
      '\t',
    );

    assert.equal(
      csv,
      'snapshot,status,changed_pixels,total_pixels,changed_percent,width,height,baseline,new,diff\n' +
        'sub dir/b.png,changed,37,400,9.25,20,20,sub dir/b.png,sub dir/b.new.png,sub dir/b.diff.png\n' +
        '"a,""quoted"".png",new,0,400,0,20,20,"a,""quoted"".png",,\n' +
        'z.png,unchanged,0,400,0,20,20,z.png,,\n',
    );
    assert.equal(
      tsv.split('\n')[1],
      'tab here.png\tunchanged\t0\t400\t0\t20\t20\ttab here.png\t\t',
    );
  });
});
