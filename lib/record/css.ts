// CSS lengths, as a page or a PDF setting gives them.

const UNITS: Record<string, number> = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72 };

/**
 * A length as CSS pixels: a number is pixels; a string is a number and one of px, in, cm, mm or
 * pt. NaN when it is neither.
 *
 * ```ts
 * import * as CSS from './css.ts';
 *
 * CSS.toPixels('1in'); // 96
 * CSS.toPixels('210mm'); // 793.7007874015749
 * CSS.toPixels(12); // 12
 * ```
 */
export function toPixels(length: string | number): number {
  if (typeof length === 'number') return length;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(px|in|cm|mm|pt)?\s*$/i.exec(length);
  return match ? Number(match[1]) * UNITS[(match[2] ?? 'px').toLowerCase()] : NaN;
}
