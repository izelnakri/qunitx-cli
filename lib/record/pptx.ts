import {
  CORE_TYPE,
  contentTypes,
  coreProperties,
  emu,
  hexColor,
  relationships,
  xml,
} from './ooxml.ts';
import { zip, type ZipEntry } from './zip.ts';

/**
 * One step of a recording, as a document or a deck shows it: its title, its caption and notes,
 * and its picture — the step's last frame, as a JPEG.
 *
 * ```ts
 * const step: OfficeStep = { title: 'Pay', caption: 'Card details go here', notes: null, jpeg: new Uint8Array(0) };
 * ```
 */
export interface OfficeStep {
  /** What the step is called: a slide's title, a document's heading. */
  title: string;
  /** What the panel shows under the title; null without one. */
  caption: string | null;
  /** The step's notes: a slide's speaker notes; a paragraph in a document. */
  notes: string | null;
  /** Its picture. */
  jpeg: Uint8Array;
}

/**
 * How a deck is laid out: the recording's canvas, and its panel — the band above or below it for
 * the step's title and caption — in CSS pixels, with the panel's colors as CSS.
 *
 * ```ts
 * const layout: DeckLayout = {
 *   canvas: { width: 1280, height: 720 },
 *   panel: { placement: 'below', height: 96, background: '#11141c', color: '#f1f3f5' },
 * };
 * ```
 */
export interface DeckLayout {
  /** The size every step's picture is shown at. */
  canvas: { width: number; height: number };
  /** The band for the title and caption. */
  panel: {
    placement: 'above' | 'below';
    height: number;
    /** A CSS color; anything else — a gradient, a variable — falls back to the panel's own. */
    background?: unknown;
    /** Likewise, for its text. */
    color?: unknown;
  };
}

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const TYPE = 'application/vnd.openxmlformats-officedocument.presentationml';
// PowerPoint's limits on a slide's sides: 1 inch to 56.
const MIN_SIDE = 914400;
const MAX_SIDE = 51206400;
// The panel's own look (see panel.ts): padding, and its title's and caption's text, in pixels.
const PADDING = { x: 20, y: 12 };
const TITLE_SIZE = 18;
const CAPTION_SIZE = 15;

/**
 * A PowerPoint deck of `steps`, a slide each: the step's picture as the canvas shows it, its
 * title — a real title, which outlines, screen readers and Google Slides list — and caption in
 * the panel's band, and its notes as the slide's speaker notes. Opens in PowerPoint, Keynote,
 * Google Slides and LibreOffice Impress; no dates, so the same steps make the same file.
 *
 * ```ts
 * import { writePptx } from './pptx.ts';
 *
 * const pptx = writePptx('Empty', [], {
 *   canvas: { width: 1280, height: 720 },
 *   panel: { placement: 'below', height: 96 },
 * });
 * [pptx[0], pptx[1]]; // [0x50, 0x4b] — a ZIP, as every .pptx is
 * ```
 */
export function writePptx(title: string, steps: OfficeStep[], layout: DeckLayout): Uint8Array {
  const { canvas, panel } = layout;
  const width = canvas.width;
  const height = canvas.height + panel.height;
  // Shrunk to fit PowerPoint's largest slide, or grown to its smallest, keeping its shape.
  const fit =
    Math.min(1, MAX_SIDE / emu(width), MAX_SIDE / emu(height)) *
    Math.max(1, MIN_SIDE / emu(Math.min(width, height)));
  const at = (pixels: number) => Math.round(emu(pixels) * fit);
  const size = { cx: at(width), cy: at(height) };
  const top = panel.placement === 'above' ? panel.height : 0;
  const band = panel.placement === 'above' ? 0 : canvas.height;
  const background = hexColor(panel.background, '11141C');
  const color = hexColor(panel.color, 'F1F3F5');
  const box = (x: number, y: number, w: number, h: number) =>
    `<a:xfrm><a:off x="${at(x)}" y="${at(y)}"/><a:ext cx="${at(w)}" cy="${at(h)}"/></a:xfrm>`;
  const titleBox = box(PADDING.x, band + PADDING.y, width - 2 * PADDING.x, TITLE_SIZE * 1.5);
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];
  const part = (name: string, text: string) => entries.push({ name, bytes: encoder.encode(text) });
  const points = (pixels: number) => Math.round(pixels * 75 * fit);

  part(
    '[Content_Types].xml',
    contentTypes(
      { jpeg: 'image/jpeg' },
      {
        '/ppt/presentation.xml': `${TYPE}.presentation.main+xml`,
        '/ppt/slideMasters/slideMaster1.xml': `${TYPE}.slideMaster+xml`,
        '/ppt/slideLayouts/slideLayout1.xml': `${TYPE}.slideLayout+xml`,
        '/ppt/notesMasters/notesMaster1.xml': `${TYPE}.notesMaster+xml`,
        '/ppt/theme/theme1.xml': 'application/vnd.openxmlformats-officedocument.theme+xml',
        '/ppt/theme/theme2.xml': 'application/vnd.openxmlformats-officedocument.theme+xml',
        '/ppt/presProps.xml': `${TYPE}.presProps+xml`,
        '/ppt/viewProps.xml': `${TYPE}.viewProps+xml`,
        '/ppt/tableStyles.xml': `${TYPE}.tableStyles+xml`,
        '/docProps/core.xml': CORE_TYPE,
        ...Object.fromEntries(
          steps.flatMap((_, index) => [
            [`/ppt/slides/slide${index + 1}.xml`, `${TYPE}.slide+xml`],
            [`/ppt/notesSlides/notesSlide${index + 1}.xml`, `${TYPE}.notesSlide+xml`],
          ]),
        ),
      },
    ),
  );
  part(
    '_rels/.rels',
    relationships([
      { id: 'rId1', kind: 'officeDocument', target: 'ppt/presentation.xml' },
      { id: 'rId2', kind: 'core-properties', target: 'docProps/core.xml' },
    ]),
  );
  part('docProps/core.xml', coreProperties(title));
  part(
    'ppt/presentation.xml',
    `${HEAD}<p:presentation ${NS} saveSubsetFonts="1">` +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      '<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>' +
      (steps.length
        ? `<p:sldIdLst>${steps.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${10 + index}"/>`).join('')}</p:sldIdLst>`
        : '') +
      `<p:sldSz cx="${size.cx}" cy="${size.cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  );
  part(
    'ppt/_rels/presentation.xml.rels',
    relationships([
      { id: 'rId1', kind: 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
      { id: 'rId2', kind: 'notesMaster', target: 'notesMasters/notesMaster1.xml' },
      { id: 'rId3', kind: 'theme', target: 'theme/theme1.xml' },
      { id: 'rId4', kind: 'presProps', target: 'presProps.xml' },
      { id: 'rId5', kind: 'viewProps', target: 'viewProps.xml' },
      { id: 'rId6', kind: 'tableStyles', target: 'tableStyles.xml' },
      ...steps.map((_, index) => ({
        id: `rId${10 + index}`,
        kind: 'slide',
        target: `slides/slide${index + 1}.xml`,
      })),
    ]),
  );
  part('ppt/presProps.xml', `${HEAD}<p:presentationPr ${NS}/>`);
  part('ppt/viewProps.xml', `${HEAD}<p:viewPr ${NS}/>`);
  part(
    'ppt/tableStyles.xml',
    `${HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
  );
  part('ppt/theme/theme1.xml', theme());
  part('ppt/theme/theme2.xml', theme());

  const titleShape = (text: string | null) =>
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
    `<p:spPr>${titleBox}</p:spPr>` +
    '<p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/>' +
    (text === null
      ? '<a:p><a:endParaRPr lang="en-US"/></a:p>'
      : `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xml(text)}</a:t></a:r></a:p>`) +
    '</p:txBody></p:sp>';
  const tree = (shapes: string) =>
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    `${shapes}</p:spTree>`;
  const colorMap =
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
    'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
  part(
    'ppt/slideMasters/slideMaster1.xml',
    `${HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>` +
      `${tree(titleShape(null))}</p:cSld>${colorMap}` +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
      '<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr ' +
      `sz="${points(TITLE_SIZE)}" b="1"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
      '<a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>',
  );
  part(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    relationships([
      { id: 'rId1', kind: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', kind: 'theme', target: '../theme/theme1.xml' },
    ]),
  );
  part(
    'ppt/slideLayouts/slideLayout1.xml',
    `${HEAD}<p:sldLayout ${NS} type="titleOnly" preserve="1"><p:cSld name="Step">${tree(titleShape(null))}</p:cSld>` +
      '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>',
  );
  part(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    relationships([
      { id: 'rId1', kind: 'slideMaster', target: '../slideMasters/slideMaster1.xml' },
    ]),
  );
  // Notes pages are portrait 7.5 × 10 inches: the slide above, its notes below.
  const notesShape = (id: number, type: 'sldImg' | 'body', placed: boolean, body = '') =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${type === 'body' ? 'Notes' : 'Slide Image'}"/>` +
    `<p:cNvSpPr><a:spLocks noGrp="1"${type === 'sldImg' ? ' noRot="1" noChangeAspect="1"' : ''}/></p:cNvSpPr>` +
    `<p:nvPr><p:ph type="${type}"${type === 'body' ? ' idx="1"' : ''}/></p:nvPr></p:nvSpPr>` +
    (placed
      ? type === 'sldImg'
        ? '<p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
        : '<p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
      : '<p:spPr/>') +
    (type === 'body' ? `<p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody>` : '') +
    '</p:sp>';
  part(
    'ppt/notesMasters/notesMaster1.xml',
    `${HEAD}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>` +
      `${tree(notesShape(2, 'sldImg', true) + notesShape(3, 'body', true, '<a:p><a:endParaRPr lang="en-US"/></a:p>'))}</p:cSld>${colorMap}</p:notesMaster>`,
  );
  part(
    'ppt/notesMasters/_rels/notesMaster1.xml.rels',
    relationships([{ id: 'rId1', kind: 'theme', target: '../theme/theme2.xml' }]),
  );

  steps.forEach((step, index) => {
    const number = index + 1;
    entries.push({ name: `ppt/media/image${number}.jpeg`, bytes: step.jpeg, stored: true });
    const caption = step.caption
      ? '<p:sp><p:nvSpPr><p:cNvPr id="5" name="Caption"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
        `<p:spPr>${box(PADDING.x, band + PADDING.y + TITLE_SIZE * 1.6, width - 2 * PADDING.x, panel.height - 2 * PADDING.y - TITLE_SIZE * 1.6)}` +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
        '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>' +
        `<a:p><a:r><a:rPr lang="en-US" sz="${points(CAPTION_SIZE)}" dirty="0"><a:solidFill><a:srgbClr val="${color}"><a:alpha val="85000"/></a:srgbClr></a:solidFill>` +
        `<a:latin typeface="+mn-lt"/></a:rPr><a:t>${xml(step.caption)}</a:t></a:r></a:p></p:txBody></p:sp>`
      : '';
    const shapes =
      // The band behind the title and caption.
      '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Panel"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
      `<p:spPr>${box(0, band, width, panel.height)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      `<a:solidFill><a:srgbClr val="${background}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>` +
      `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Step ${number}" descr="${xml([step.title, step.caption].filter(Boolean).join(': '))}"/>` +
      '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
      '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
      `<p:spPr>${box(0, top, canvas.width, canvas.height)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` +
      titleShape(step.title) +
      caption;
    part(
      `ppt/slides/slide${number}.xml`,
      `${HEAD}<p:sld ${NS}><p:cSld>${tree(shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    );
    part(
      `ppt/slides/_rels/slide${number}.xml.rels`,
      relationships([
        { id: 'rId1', kind: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
        { id: 'rId2', kind: 'image', target: `../media/image${number}.jpeg` },
        { id: 'rId3', kind: 'notesSlide', target: `../notesSlides/notesSlide${number}.xml` },
      ]),
    );
    const paragraphs = step.notes
      ? step.notes
          .split(/\r?\n/)
          .map(
            (line) =>
              `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xml(line)}</a:t></a:r></a:p>`,
          )
          .join('')
      : '<a:p><a:endParaRPr lang="en-US"/></a:p>';
    part(
      `ppt/notesSlides/notesSlide${number}.xml`,
      `${HEAD}<p:notes ${NS}><p:cSld>${tree(notesShape(2, 'sldImg', false) + notesShape(3, 'body', false, paragraphs))}</p:cSld>` +
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>',
    );
    part(
      `ppt/notesSlides/_rels/notesSlide${number}.xml.rels`,
      relationships([
        { id: 'rId1', kind: 'notesMaster', target: '../notesMasters/notesMaster1.xml' },
        { id: 'rId2', kind: 'slide', target: `../slides/slide${number}.xml` },
      ]),
    );
  });
  return zip(entries);
}

// A theme: every master needs one. Arial, which every app that opens a .pptx has.
function theme(): string {
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const accents = ['4C6EF5', '12B886', 'FAB005', 'FA5252', '7950F2', '15AABF']
    .map((hex, index) => `<a:accent${index + 1}><a:srgbClr val="${hex}"/></a:accent${index + 1}>`)
    .join('');
  return (
    `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="qunitx">` +
    '<a:themeElements><a:clrScheme name="qunitx">' +
    '<a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="11141C"/></a:dk2><a:lt2><a:srgbClr val="F1F3F5"/></a:lt2>' +
    `${accents}<a:hlink><a:srgbClr val="1C7ED6"/></a:hlink><a:folHlink><a:srgbClr val="7048E8"/></a:folHlink></a:clrScheme>` +
    '<a:fontScheme name="qunitx">' +
    '<a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
    '<a:fmtScheme name="qunitx">' +
    `<a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst>` +
    `<a:lnStyleLst>${`<a:ln w="6350">${fill}</a:ln>`.repeat(3)}</a:lnStyleLst>` +
    `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>` +
    `<a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme>` +
    '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
  );
}
