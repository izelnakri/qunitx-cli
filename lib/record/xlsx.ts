import { CORE_TYPE, contentTypes, coreProperties, relationships, xml } from './ooxml.ts';
import { zip, type ZipEntry } from './zip.ts';

/**
 * A cell: text, a number, or either with a look — `count` (`1,234`), `percent` (a fraction shown
 * as `12.34%`), `strong` — or a `link` that opens a URL or a file beside the workbook. A formula
 * gives its `value` as computed, which every app shows until it recalculates. `null` is empty.
 *
 * ```ts
 * const cells: Cell[] = ['home.png', { value: 0.0123, look: 'percent' }, { value: 'diff', link: 'home.diff.png' }, null];
 * ```
 */
export type Cell =
  | string
  | number
  | null
  | {
      /** What it holds, or what its formula comes to. */
      value: string | number;
      look?: 'count' | 'percent' | 'strong' | Tone;
      /** Opens this when clicked: a URL, or a path relative to the workbook. */
      link?: string;
      /** A formula, without its `=`: `SUM(B2:B5)`. */
      formula?: string;
    };

/**
 * A highlight a cell can take: bold on a pale tint of red, blue, yellow or green.
 *
 * ```ts
 * const tone: Tone = 'red';
 * ```
 */
export type Tone = 'red' | 'blue' | 'yellow' | 'green';

/**
 * One worksheet: its name on its tab, its columns — each a header and a width in characters — and
 * its rows. The header row stays in view as it scrolls, and filters on every column.
 *
 * ```ts
 * const sheet: Sheet = { name: 'Snapshots', columns: [{ header: 'Snapshot', width: 30 }], rows: [['home.png']] };
 * ```
 */
export interface Sheet {
  /** Its tab's name: up to 31 characters, none of `[]:*?/\`. */
  name: string;
  /** Each column's header and width. */
  columns: { header: string; width: number }[];
  /** Its rows, under the header. */
  rows: Cell[][];
}

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
// Indexes into STYLES' cellXfs, by look.
const LOOK = {
  header: 1,
  count: 2,
  percent: 3,
  link: 4,
  strong: 5,
  red: 6,
  blue: 7,
  yellow: 8,
  green: 9,
};

/**
 * An Excel workbook of `sheets`, each a tab. Opens in Excel, Google Sheets, Proton Sheets, Numbers
 * and LibreOffice Calc; no dates, so the same sheets make the same file.
 *
 * ```ts
 * import { writeXlsx } from './xlsx.ts';
 *
 * const xlsx = writeXlsx('Empty', [{ name: 'Sheet1', columns: [], rows: [] }]);
 * [xlsx[0], xlsx[1]]; // [0x50, 0x4b] — a ZIP, as every .xlsx is
 * ```
 */
export function writeXlsx(title: string, sheets: Sheet[]): Uint8Array {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];
  const part = (name: string, text: string) => entries.push({ name, bytes: encoder.encode(text) });
  const names = sheets.map((sheet, index) => sheetName(sheet.name, index));

  part(
    '[Content_Types].xml',
    contentTypes(
      {},
      {
        '/xl/workbook.xml': `${TYPE}.sheet.main+xml`,
        '/xl/styles.xml': `${TYPE}.styles+xml`,
        '/docProps/core.xml': CORE_TYPE,
        ...Object.fromEntries(
          sheets.map((_, index) => [
            `/xl/worksheets/sheet${index + 1}.xml`,
            `${TYPE}.worksheet+xml`,
          ]),
        ),
      },
    ),
  );
  part(
    '_rels/.rels',
    relationships([
      { id: 'rId1', kind: 'officeDocument', target: 'xl/workbook.xml' },
      { id: 'rId2', kind: 'core-properties', target: 'docProps/core.xml' },
    ]),
  );
  part('docProps/core.xml', coreProperties(title));
  // A filter's range is a hidden name Excel keeps per sheet; without it the filter is a stub.
  const filters = sheets
    .map((sheet, index) =>
      sheet.columns.length
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${index}" hidden="1">` +
          `'${xml(names[index].replace(/'/g, "''"))}'!$A$1:$${column(sheet.columns.length - 1)}$${sheet.rows.length + 1}</definedName>`
        : '',
    )
    .join('');
  part(
    'xl/workbook.xml',
    `${HEAD}<workbook xmlns="${MAIN}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>${names.map((name, index) => `<sheet name="${xml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>` +
      (filters ? `<definedNames>${filters}</definedNames>` : '') +
      '</workbook>',
  );
  part(
    'xl/_rels/workbook.xml.rels',
    relationships([
      ...sheets.map((_, index) => ({
        id: `rId${index + 1}`,
        kind: 'worksheet',
        target: `worksheets/sheet${index + 1}.xml`,
      })),
      { id: `rId${sheets.length + 1}`, kind: 'styles', target: 'styles.xml' },
    ]),
  );
  part('xl/styles.xml', STYLES);
  sheets.forEach((sheet, index) => {
    const links: { ref: string; target: string }[] = [];
    const rows = [
      sheet.columns.map((entry) => ({ value: entry.header, look: 'header' as const })),
      ...sheet.rows,
    ];
    const data = rows
      .map((row, at) => {
        const cells = row
          .map((cell, col) => {
            const ref = `${column(col)}${at + 1}`;
            if (cell === null || cell === '') return '';
            const full = typeof cell === 'object' ? cell : { value: cell };
            if ('link' in full && full.link) links.push({ ref, target: full.link });
            const look = 'look' in full && full.look ? LOOK[full.look] : full.link ? LOOK.link : 0;
            const style = look ? ` s="${look}"` : '';
            const formula = 'formula' in full && full.formula ? `<f>${xml(full.formula)}</f>` : '';
            return typeof full.value === 'number'
              ? `<c r="${ref}"${style}>${formula}<v>${full.value}</v></c>`
              : formula
                ? `<c r="${ref}"${style} t="str">${formula}<v>${xml(full.value)}</v></c>`
                : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(full.value)}</t></is></c>`;
          })
          .join('');
        return `<row r="${at + 1}">${cells}</row>`;
      })
      .join('');
    const last = `${column(Math.max(0, sheet.columns.length - 1))}${rows.length}`;
    part(
      `xl/worksheets/sheet${index + 1}.xml`,
      `${HEAD}<worksheet xmlns="${MAIN}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<dimension ref="A1:${last}"/>` +
        `<sheetViews><sheetView workbookViewId="0"${index === 0 ? ' tabSelected="1"' : ''}>` +
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
        '<sheetFormatPr defaultRowHeight="15"/>' +
        (sheet.columns.length
          ? `<cols>${sheet.columns.map((entry, col) => `<col min="${col + 1}" max="${col + 1}" width="${entry.width}" customWidth="1"/>`).join('')}</cols>`
          : '') +
        `<sheetData>${data}</sheetData>` +
        (sheet.columns.length ? `<autoFilter ref="A1:${last}"/>` : '') +
        (links.length
          ? `<hyperlinks>${links.map((link, at) => `<hyperlink ref="${link.ref}" r:id="rId${at + 1}"/>`).join('')}</hyperlinks>`
          : '') +
        '</worksheet>',
    );
    if (links.length) {
      part(
        `xl/worksheets/_rels/sheet${index + 1}.xml.rels`,
        relationships(
          links.map((link, at) => ({
            id: `rId${at + 1}`,
            kind: 'hyperlink',
            target: link.target,
            external: true,
          })),
        ),
      );
    }
  });
  return zip(entries);
}

/**
 * A spreadsheet column's letters, from 0: `A` … `Z`, `AA` ….
 *
 * ```ts
 * import { column } from './xlsx.ts';
 *
 * [column(0), column(25), column(26), column(701)]; // ['A', 'Z', 'AA', 'ZZ']
 * ```
 */
export function column(index: number): string {
  let letters = '';
  for (let at = index + 1; at > 0; at = Math.floor((at - 1) / 26)) {
    letters = String.fromCharCode(65 + ((at - 1) % 26)) + letters;
  }
  return letters;
}

// A tab's name as Excel takes it: 1–31 characters, none of `[]:*?/\`, not starting or ending in `'`.
function sheetName(name: string, index: number): string {
  const cleaned = name
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/^'+|'+$/g, '')
    .slice(0, 31)
    .trim();
  return cleaned || `Sheet${index + 1}`;
}

const tint = (rgb: string) =>
  `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
// Fonts: plain, bold, link. Fills: the two every workbook starts with, then the header's gray and
// the four tones. Cell looks, in LOOK's order.
const STYLES =
  `${HEAD}<styleSheet xmlns="${MAIN}">` +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.00%"/></numFmts>' +
  '<fonts count="3"><font><sz val="11"/><name val="Arial"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Arial"/><family val="2"/></font>' +
  '<font><u/><sz val="11"/><color rgb="FF1C7ED6"/><name val="Arial"/><family val="2"/></font></fonts>' +
  '<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  `${tint('F1F3F5')}${tint('FFE3E3')}${tint('E7F5FF')}${tint('FFF3BF')}${tint('EBFBEE')}</fills>` +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="10">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  [3, 4, 5, 6]
    .map(
      (fill) =>
        `<xf numFmtId="0" fontId="1" fillId="${fill}" borderId="0" xfId="0" applyFont="1" applyFill="1"/>`,
    )
    .join('') +
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
