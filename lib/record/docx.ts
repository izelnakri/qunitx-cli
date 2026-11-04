import * as JPEG from './jpeg.ts';
import { CORE_TYPE, contentTypes, coreProperties, emu, relationships, xml } from './ooxml.ts';
import type { OfficeStep } from './pptx.ts';
import { zip, type ZipEntry } from './zip.ts';

/**
 * A document's page: its size and margins, in CSS pixels.
 *
 * ```ts
 * const page: DocxPage = { width: 794, height: 1123, margin: { top: 96, right: 96, bottom: 96, left: 96 } };
 * ```
 */
export interface DocxPage {
  /** The page's width. */
  width: number;
  /** The page's height. */
  height: number;
  /** Between the page's edges and its text. */
  margin: { top: number; right: number; bottom: number; left: number };
}

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
// Twentieths of a point: Word's page unit. 15 to a CSS pixel.
const TWIPS = 15;
// What of the page's height a picture may take, leaving room for its heading and caption.
const PICTURE_SHARE = 0.72;

/**
 * A Word document of `steps`: the recording's title, then for each step a heading, its picture
 * fitted to the page, its caption and its notes — styled `Title`, `Heading 1` and `Caption`, so
 * Word's navigation pane and Google Docs' outline list the steps. Opens in Word, Google Docs,
 * Proton Docs, Pages and LibreOffice Writer; no dates, so the same steps make the same file.
 *
 * ```ts
 * import { writeDocx } from './docx.ts';
 *
 * const docx = writeDocx('Empty', [], { width: 794, height: 1123, margin: { top: 96, right: 96, bottom: 96, left: 96 } });
 * [docx[0], docx[1]]; // [0x50, 0x4b] — a ZIP, as every .docx is
 * ```
 */
export function writeDocx(title: string, steps: OfficeStep[], page: DocxPage): Uint8Array {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];
  const media: ZipEntry[] = [];
  const part = (name: string, text: string) => entries.push({ name, bytes: encoder.encode(text) });
  const room = {
    width: page.width - page.margin.left - page.margin.right,
    height: (page.height - page.margin.top - page.margin.bottom) * PICTURE_SHARE,
  };
  const paragraph = (text: string, style?: string, keepNext = false) =>
    `<w:p>${style || keepNext ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${keepNext ? '<w:keepNext/>' : ''}</w:pPr>` : ''}` +
    text
      .split(/\r?\n/)
      .map(
        (line, index) =>
          `${index ? '<w:r><w:br/></w:r>' : ''}<w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r>`,
      )
      .join('') +
    '</w:p>';

  const body = steps.map((step, index) => {
    const number = index + 1;
    media.push({ name: `word/media/image${number}.jpeg`, bytes: step.jpeg, stored: true });
    // Its own size at most; smaller to fit the page's width, and its height share.
    const pixels = JPEG.getDimensions(step.jpeg);
    const shown = Math.min(1, room.width / pixels.width, room.height / pixels.height);
    const cx = emu(pixels.width * shown);
    const cy = emu(pixels.height * shown);
    const alt = xml([step.title, step.caption].filter(Boolean).join(': '));
    const picture =
      '<w:p><w:pPr><w:keepNext/><w:jc w:val="center"/></w:pPr><w:r><w:drawing>' +
      `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:docPr id="${number}" name="Step ${number}" descr="${alt}"/>` +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
      `<pic:nvPicPr><pic:cNvPr id="${number}" name="Step ${number}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="rIdImage${number}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
    return (
      paragraph(step.title, 'Heading1', true) +
      picture +
      (step.caption ? paragraph(step.caption, 'Caption') : '') +
      (step.notes ? paragraph(step.notes) : '')
    );
  });
  const twips = (pixels: number) => Math.round(pixels * TWIPS);
  const section =
    `<w:sectPr><w:pgSz w:w="${twips(page.width)}" w:h="${twips(page.height)}"${page.width > page.height ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="${twips(page.margin.top)}" w:right="${twips(page.margin.right)}" w:bottom="${twips(page.margin.bottom)}" ` +
    `w:left="${twips(page.margin.left)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
  const document = `${HEAD}<w:document ${NS}><w:body>${paragraph(title, 'Title')}${body.join('')}${section}</w:body></w:document>`;

  part(
    '[Content_Types].xml',
    contentTypes(
      { jpeg: 'image/jpeg' },
      {
        '/word/document.xml':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
        '/word/styles.xml':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
        '/docProps/core.xml': CORE_TYPE,
      },
    ),
  );
  part(
    '_rels/.rels',
    relationships([
      { id: 'rId1', kind: 'officeDocument', target: 'word/document.xml' },
      { id: 'rId2', kind: 'core-properties', target: 'docProps/core.xml' },
    ]),
  );
  part('docProps/core.xml', coreProperties(title));
  part('word/document.xml', document);
  part(
    'word/_rels/document.xml.rels',
    relationships([
      { id: 'rIdStyles', kind: 'styles', target: 'styles.xml' },
      ...steps.map((_, index) => ({
        id: `rIdImage${index + 1}`,
        kind: 'image',
        target: `media/image${index + 1}.jpeg`,
      })),
    ]),
  );
  part('word/styles.xml', STYLES);
  return zip([...entries, ...media]);
}

// The styles the document uses, by the names Word, Google Docs and LibreOffice map to their own.
const STYLES =
  `${HEAD}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="320"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>' +
  '<w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>' +
  '</w:styles>';
