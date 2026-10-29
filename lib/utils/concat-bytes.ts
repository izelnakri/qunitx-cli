/**
 * `parts` joined into one plain `Uint8Array`. Not `Buffer.concat`: that returns a `Buffer`, whose
 * `slice()` is a view sharing the bytes where a `Uint8Array`'s is a copy, so a caller that copies
 * a result with `slice()` and edits it would edit the original too.
 *
 * ```ts
 * import { concatBytes } from './concat-bytes.ts';
 *
 * concatBytes([Uint8Array.of(1, 2), Uint8Array.of(3)]); // Uint8Array [1, 2, 3]
 * ```
 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  parts.reduce((offset, part) => (joined.set(part, offset), offset + part.length), 0);
  return joined;
}
