// What every Office Open XML package (.docx, .xlsx, .pptx) has in common: XML text, the content
// types of its parts, the relationships between them, and its document properties.

/**
 * `text` made safe inside XML, as an element's text or an attribute's value. Characters XML 1.0
 * cannot hold at all — control characters other than tab and line breaks — are left out.
 *
 * ```ts
 * import { xml } from './ooxml.ts';
 *
 * xml('Fish & "chips" <3'); // 'Fish &amp; &quot;chips&quot; &lt;3'
 * ```
 */
export function xml(text: string): string {
  return [...text]
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return (
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 0x20 && code !== 0xfffe && code !== 0xffff)
      );
    })
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The namespace of a relationship of `kind` between parts: `image`, `slide`, `styles`… and the
 * package-level `core-properties`.
 *
 * ```ts
 * import { relationship } from './ooxml.ts';
 *
 * relationship('image'); // 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
 * ```
 */
export function relationship(kind: string): string {
  return kind === 'core-properties'
    ? 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties'
    : `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}`;
}

/**
 * A part's relationships (`_rels/….rels`): each an id, a kind (see {@link relationship}) and its
 * target, relative to the part — or, `external`, a link out of the package: a URL, or a file
 * beside it.
 *
 * ```ts
 * import { relationships } from './ooxml.ts';
 *
 * relationships([{ id: 'rId1', kind: 'image', target: '../media/image1.jpeg' }]).includes('Id="rId1"'); // true
 * ```
 */
export function relationships(
  list: { id: string; kind: string; target: string; external?: boolean }[],
): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    list
      .map(
        ({ id, kind, target, external }) =>
          `<Relationship Id="${id}" Type="${relationship(kind)}" Target="${xml(target)}"${external ? ' TargetMode="External"' : ''}/>`,
      )
      .join('') +
    '</Relationships>'
  );
}

/**
 * `[Content_Types].xml`: the type of each part, by its extension or, overriding that, its name.
 *
 * ```ts
 * import { contentTypes } from './ooxml.ts';
 *
 * contentTypes({ jpeg: 'image/jpeg' }, { '/word/document.xml': 'application/x-example' }).includes('Extension="jpeg"'); // true
 * ```
 */
export function contentTypes(
  defaults: Record<string, string>,
  overrides: Record<string, string>,
): string {
  const all = {
    rels: 'application/vnd.openxmlformats-package.relationships+xml',
    xml: 'application/xml',
    ...defaults,
  };
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    Object.entries(all)
      .map(([extension, type]) => `<Default Extension="${extension}" ContentType="${type}"/>`)
      .join('') +
    Object.entries(overrides)
      .map(([part, type]) => `<Override PartName="${xml(part)}" ContentType="${type}"/>`)
      .join('') +
    '</Types>'
  );
}

/**
 * The content type of a package's core properties part, `docProps/core.xml`.
 *
 * ```ts
 * import { CORE_TYPE } from './ooxml.ts';
 *
 * CORE_TYPE.endsWith('core-properties+xml'); // true
 * ```
 */
export const CORE_TYPE = 'application/vnd.openxmlformats-package.core-properties+xml';

/**
 * `docProps/core.xml`: the document's title, and what made it. No dates, so the same recording
 * makes the same file.
 *
 * ```ts
 * import { coreProperties } from './ooxml.ts';
 *
 * coreProperties('Checkout').includes('<dc:title>Checkout</dc:title>'); // true
 * ```
 */
export function coreProperties(title: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:title>${xml(title)}</dc:title><dc:creator>qunitx record</dc:creator></cp:coreProperties>`
  );
}

/**
 * CSS pixels as EMUs, the unit DrawingML places and sizes everything in: 9525 to a pixel, 914400
 * to an inch.
 *
 * ```ts
 * import { emu } from './ooxml.ts';
 *
 * emu(96); // 914400
 * ```
 */
export function emu(pixels: number): number {
  return Math.round(pixels * 9525);
}

/**
 * A CSS color as the six hex digits DrawingML takes — `#rgb`, `#rrggbb` or `rgb(…)` — or
 * `fallback` for anything else (a gradient, a variable, a name).
 *
 * ```ts
 * import { hexColor } from './ooxml.ts';
 *
 * [hexColor('#5f3dc4', '000000'), hexColor('rgb(255, 0, 10)', '000000'), hexColor('tomato', '11141C')];
 * // ['5F3DC4', 'FF000A', '11141C']
 * ```
 */
export function hexColor(css: unknown, fallback: string): string {
  const text = typeof css === 'string' ? css.trim() : '';
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short) return (short[1] + short[1] + short[2] + short[2] + short[3] + short[3]).toUpperCase();
  const long = /^#([0-9a-f]{6})$/i.exec(text);
  if (long) return long[1].toUpperCase();
  const rgb = /^rgba?\(\s*(\d+)\s*,?\s*(\d+)\s*,?\s*(\d+)/i.exec(text);
  if (rgb) {
    return rgb
      .slice(1, 4)
      .map((part) => Math.min(255, Number(part)).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }
  return fallback;
}
