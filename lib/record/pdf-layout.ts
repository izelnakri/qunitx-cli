import type { Page } from 'playwright-core';

/**
 * A form control as the page lays it out, for a PDF to make it a field: what kind it is, its
 * name and value, how it is drawn, and where, in CSS pixels from the top-left of the document.
 *
 * ```ts
 * const field: LaidOutField = {
 *   kind: 'text', name: 'email', value: 'ada@example.com', checked: false, options: [], multiple: false,
 *   label: 'Email', required: true, readOnly: false, maxLength: null, password: false,
 *   rect: { x: 20, y: 40, width: 240, height: 32 },
 *   font: { size: 16, color: [0.1, 0.1, 0.1], align: 'left' }, padding: { left: 8, right: 8, top: 6 },
 *   action: null,
 * };
 * ```
 */
export interface LaidOutField {
  /** What it becomes: a text field (`text`, or `textarea` over several lines), a check box, a
   * radio button, a drop-down (`select`), a list box (`list`: a `<select>` with `multiple` or a
   * `size`), or a button that submits or resets the form. */
  kind: 'text' | 'textarea' | 'checkbox' | 'radio' | 'select' | 'list' | 'submit' | 'reset';
  /** Its `name`, else its `id`; empty when it has neither. */
  name: string;
  /** What it holds: typed text, or a check box's or radio button's `value`. */
  value: string;
  /** Whether a check box or radio button is on. */
  checked: boolean;
  /** A select's options: what each submits, what it shows, and whether it is chosen. */
  options: { value: string; label: string; selected: boolean }[];
  /** A list that takes more than one choice: `<select multiple>`. */
  multiple: boolean;
  /** Its accessible name: `aria-label`, its `<label>`, else its placeholder or title. */
  label: string;
  /** `required`: a PDF reader asks for it before submitting. */
  required: boolean;
  /** `readonly` or `disabled`: shown, not editable. */
  readOnly: boolean;
  /** `maxlength`, when it has one. */
  maxLength: number | null;
  /** A password field: its text drawn as bullets. */
  password: boolean;
  /** Where it is, in CSS pixels from the document's top-left. */
  rect: { x: number; y: number; width: number; height: number };
  /** Its text's size in CSS pixels, color as 0–1 RGB, and alignment. */
  font: { size: number; color: [number, number, number]; align: 'left' | 'center' | 'right' };
  /** Its padding and border on each side, in CSS pixels: where its text starts. */
  padding: { left: number; right: number; top: number };
  /** For a submit button: where and how its form sends what is filled in. */
  action: { url: string; method: 'GET' | 'POST' } | null;
}

/**
 * Everything printing a page with its forms needs from its layout, in CSS pixels from the top of
 * the document: its fields, the boxes a page break must not cut through (lines of text, controls,
 * pictures, table rows, `break-inside: avoid`), the breaks its CSS forces, its headings for an
 * outline, and its full size.
 *
 * ```ts
 * const layout: PageLayout = { width: 794, height: 2400, fields: [], blocks: [], forced: [], headings: [] };
 * ```
 */
export interface PageLayout {
  /** The document's full width. */
  width: number;
  /** The document's full height. */
  height: number;
  /** Its form controls, in document order. */
  fields: LaidOutField[];
  /** What a page break must not cut through. */
  blocks: { top: number; bottom: number }[];
  /** Where its CSS forces a page break. */
  forced: number[];
  /** Its visible headings, `h1`–`h6`, in document order. */
  headings: { level: number; text: string; top: number }[];
}

// Text-like inputs, filled in as text; anything else (file, range, color, image, hidden) stays
// printed as the page draws it.
const TEXT_TYPES = [
  'text',
  'email',
  'url',
  'tel',
  'search',
  'number',
  'password',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
];

// The in-page pass. Kept as source because lib/ is typechecked without the DOM.
const LAYOUT_SCRIPT = `(() => {
  const textTypes = ${JSON.stringify(TEXT_TYPES)};
  const at = (element) => {
    const box = element.getBoundingClientRect();
    return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height };
  };
  const shown = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const rgb = (color) => {
    const parts = (color.match(/[\\d.]+/g) || ['0', '0', '0']).slice(0, 3).map(Number);
    return parts.map((part) => Math.round((part / 255) * 1000) / 1000);
  };
  const kindOf = (element) => {
    const tag = element.tagName;
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'SELECT') return element.multiple || element.size > 1 ? 'list' : 'select';
    if (tag === 'BUTTON') return element.type === 'submit' ? 'submit' : element.type === 'reset' ? 'reset' : null;
    const type = element.type;
    if (type === 'checkbox' || type === 'radio') return type;
    if (type === 'submit' || type === 'reset') return type;
    return textTypes.includes(type) ? 'text' : null;
  };
  const labelOf = (element) =>
    (element.getAttribute('aria-label') || (element.labels && element.labels[0] && element.labels[0].textContent) ||
      element.placeholder || element.title || '').replace(/\\s+/g, ' ').trim();
  const fields = [];
  for (const element of document.querySelectorAll('input, textarea, select, button')) {
    const kind = kindOf(element);
    if (!kind || !shown(element) || element.closest('[inert]')) continue;
    const style = getComputedStyle(element);
    const form = element.form;
    element.setAttribute('data-qunitx-field', String(fields.length));
    const actionUrl = form && form.getAttribute('action') !== null ? form.action : '';
    fields.push({
      kind,
      name: element.name || element.id || '',
      value: kind === 'submit' || kind === 'reset' ? (element.value || element.textContent || '').trim() : element.value || '',
      checked: Boolean(element.checked),
      multiple: Boolean(element.multiple),
      options: element.tagName === 'SELECT'
        ? [...element.options].map((option) => ({ value: option.value, label: option.label, selected: option.selected }))
        : [],
      label: labelOf(element),
      required: Boolean(element.required),
      readOnly: Boolean(element.readOnly || element.disabled),
      maxLength: element.maxLength > 0 ? element.maxLength : null,
      password: element.type === 'password',
      rect: at(element),
      font: {
        size: parseFloat(style.fontSize) || 13,
        color: rgb(style.color),
        align: style.textAlign === 'center' ? 'center' : style.textAlign === 'right' || style.textAlign === 'end' ? 'right' : 'left',
      },
      padding: {
        left: (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.borderLeftWidth) || 0),
        right: (parseFloat(style.paddingRight) || 0) + (parseFloat(style.borderRightWidth) || 0),
        top: (parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0),
      },
      action: kind === 'submit' && /^https?:/i.test(actionUrl)
        ? { url: actionUrl, method: (form.method || 'get').toUpperCase() === 'POST' ? 'POST' : 'GET' }
        : null,
    });
  }
  const blocks = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    range.selectNodeContents(node);
    for (const line of range.getClientRects()) {
      if (line.height > 0) blocks.push({ top: line.top + scrollY, bottom: line.bottom + scrollY });
    }
  }
  // Pictures, controls and table rows are never cut, nor anything CSS asks not to be; a break
  // CSS forces before or after an element is kept.
  const atomic = 'img, svg, canvas, video, iframe, input, textarea, select, button, tr';
  const forced = [];
  for (const element of document.querySelectorAll('body *')) {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    if (box.height > 0 && (element.matches(atomic) || /^avoid/.test(style.breakInside))) {
      blocks.push({ top: box.top + scrollY, bottom: box.bottom + scrollY });
    }
    if (/^(page|always|left|right|recto|verso)$/.test(style.breakBefore)) forced.push(box.top + scrollY);
    if (/^(page|always|left|right|recto|verso)$/.test(style.breakAfter)) forced.push(box.bottom + scrollY);
  }
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
    .filter(shown)
    .map((heading) => ({ level: Number(heading.tagName[1]), text: heading.textContent.replace(/\\s+/g, ' ').trim(), top: heading.getBoundingClientRect().top + scrollY }))
    .filter((heading) => heading.text);
  const root = document.documentElement;
  // Never less than the window: Firefox measures a short page (in quirks mode too) by its content.
  return {
    width: Math.max(root.scrollWidth, root.clientWidth),
    height: Math.max(root.scrollHeight, root.clientHeight, innerHeight),
    fields, blocks, forced, headings,
  };
})()`;

/**
 * Reads a page's layout as {@link PageLayout} describes it, as it is laid out now — at the
 * viewport's width and in the CSS media emulated.
 *
 * ```ts
 * import { readLayout } from './pdf-layout.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live page.
 * async function fieldsOf(page: Page) {
 *   return (await readLayout(page)).fields.map((field) => field.name);
 * }
 * ```
 */
export async function readLayout(page: Page): Promise<PageLayout> {
  return await page.evaluate<PageLayout>(LAYOUT_SCRIPT);
}

// Lengths a viewport-relative unit (`100vh`, `height: 100%` up the root) can set. A page printed
// as one tall sheet sees the sheet as its viewport, so these are pinned at what the screen shows.
const VIEWPORT_LENGTHS = [
  'height',
  'min-height',
  'max-height',
  'top',
  'bottom',
  'margin-top',
  'margin-bottom',
  'padding-top',
  'padding-bottom',
  'row-gap',
  'flex-basis',
  'font-size',
  'line-height',
];

const SNAPSHOT_SCRIPT = `(() => {
  const lengths = ${JSON.stringify(VIEWPORT_LENGTHS)};
  const elements = [document.documentElement, ...document.querySelectorAll('body, body *')];
  globalThis.__qunitxPinned = { elements, values: elements.map((element) => {
    const style = getComputedStyle(element);
    return lengths.map((length) => style.getPropertyValue(length));
  }) };
})()`;

const PIN_SCRIPT = `(() => {
  const lengths = ${JSON.stringify(VIEWPORT_LENGTHS)};
  const { elements, values } = globalThis.__qunitxPinned;
  const pinned = [];
  elements.forEach((element, index) => {
    if (!element.isConnected) return;
    const style = getComputedStyle(element);
    const changed = lengths.flatMap((length, at) => (style.getPropertyValue(length) !== values[index][at] ? [at] : []));
    if (changed.length) pinned.push({ element, index, changed, style: element.getAttribute('style') });
  });
  // Every change is read before any is written: a pinned parent would hide its children's.
  for (const { element, index, changed } of pinned) {
    for (const at of changed) element.style.setProperty(lengths[at], values[index][at], 'important');
  }
  globalThis.__qunitxPinned = pinned;
})()`;

const UNPIN_SCRIPT = `(() => {
  for (const { element, style } of globalThis.__qunitxPinned || []) {
    if (style === null) element.removeAttribute('style');
    else element.setAttribute('style', style);
  }
  delete globalThis.__qunitxPinned;
})()`;

/**
 * Lays `page` out at `size` for printing as one tall sheet, and reads that layout: whatever
 * depends on the viewport's height is pinned at `size.height`, as the screen would show it, so
 * the tall sheet lays out the same. The returned function unpins it and puts the viewport back.
 *
 * ```ts
 * import { layoutAt } from './pdf-layout.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live page.
 * async function heightAtA4Width(page: Page) {
 *   const { layout, restore } = await layoutAt(page, { width: 794, height: 1123 });
 *   await restore();
 *   return layout.height;
 * }
 * ```
 */
export async function layoutAt(
  page: Page,
  size: { width: number; height: number },
): Promise<{ layout: PageLayout; restore: () => Promise<void> }> {
  const original =
    page.viewportSize() ??
    (await page.evaluate<{ width: number; height: number }>(
      '({ width: innerWidth, height: innerHeight })',
    ));
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  await page.setViewportSize({ width, height });
  await page.evaluate(SNAPSHOT_SCRIPT);
  await page.setViewportSize({ width, height: height + 100 });
  await page.evaluate(PIN_SCRIPT);
  await page.setViewportSize({ width, height });
  const layout = await readLayout(page);
  return {
    layout,
    restore: async () => {
      await page.evaluate(UNPIN_SCRIPT);
      await page.setViewportSize(original);
    },
  };
}

/**
 * Hides what the page itself draws of the controls `indices` names (from {@link readLayout}'s
 * `fields`, in order), so a printed field's own look is all there is of them: the text of text
 * fields and selects and the marks of check boxes and radio buttons. Buttons stay. The returned
 * function puts them back, and the page as it was.
 *
 * ```ts
 * import { hideFields } from './pdf-layout.ts';
 * import type { Page } from 'playwright-core';
 *
 * // Defined, not invoked: needs a live page.
 * async function printHidden(page: Page) {
 *   const restore = await hideFields(page, [0, 2]);
 *   try {
 *     return await page.pdf();
 *   } finally {
 *     await restore();
 *   }
 * }
 * ```
 */
export async function hideFields(page: Page, indices: number[]): Promise<() => Promise<void>> {
  const text = indices.map((index) => `[data-qunitx-field="${index}"]`).join(', ') || 'x-none';
  const css =
    `:is(${text}):not([type=checkbox], [type=radio]), :is(${text}) option, :is(${text})::placeholder ` +
    '{ color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }\n' +
    `:is(${text}) option:checked { background: transparent !important; }\n` +
    `:is(${text}):is([type=checkbox], [type=radio]) { visibility: hidden !important; }`;
  await page.evaluate(
    `(() => { const style = document.createElement('style'); style.id = 'qunitx-pdf-fields';
      style.textContent = ${JSON.stringify(css)}; document.documentElement.append(style); })()`,
  );
  return async () => {
    await page.evaluate(
      `(() => { document.getElementById('qunitx-pdf-fields')?.remove();
        for (const element of document.querySelectorAll('[data-qunitx-field]')) element.removeAttribute('data-qunitx-field'); })()`,
    );
  };
}

/**
 * Where each page of a printed document starts, from the top of a layout `height` tall, each page
 * holding up to `pageHeight` of it: the latest point that cuts through no block (a line of text,
 * a control, a picture…), or a break the CSS forces before that. Only a block taller than a whole
 * page is cut, at the page's end, as a printer would have to.
 *
 * ```ts
 * import { pageBreaks } from './pdf-layout.ts';
 *
 * pageBreaks(250, 100, [], []); // [0, 100, 200]
 * pageBreaks(250, 100, [{ top: 90, bottom: 110 }], []); // [0, 90, 190]
 * pageBreaks(250, 100, [], [40]); // [0, 40, 140, 240]
 * ```
 */
export function pageBreaks(
  height: number,
  pageHeight: number,
  blocks: { top: number; bottom: number }[],
  forced: number[],
): number[] {
  const starts = [0];
  const breaks = [...new Set(forced)].filter((at) => at > 0 && at < height).sort((a, b) => a - b);
  for (let top = 0; top + pageHeight < height - 0.5 || breaks.some((at) => at > top);) {
    const limit = top + pageHeight;
    const asked = breaks.find((at) => at > top + 0.5 && at <= limit);
    let at = asked ?? limit;
    if (asked === undefined) {
      // Up past whatever the limit would cut, and past whatever that move cuts in turn.
      for (let moved = true; moved;) {
        moved = false;
        for (const block of blocks) {
          if (block.top < at - 0.5 && block.bottom > at + 0.5 && block.top < at) {
            at = block.top;
            moved = true;
          }
        }
      }
      if (at <= top + 0.5) at = limit;
    }
    if (at >= height - 0.5) break;
    starts.push(at);
    top = at;
  }
  return starts;
}
