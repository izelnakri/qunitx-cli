/**
 * Prepends `count` repetitions of `indent` (default: one space) to each non-empty line of `string`.
 * @example
 * ```js
 * import indentString from './lib/utils/indent-string.js';
 * console.assert(indentString('hello\nworld', 2) === '  hello\n  world');
 * ```
 * @returns {string}
 */
export default function indentString(string, count = 1, options = {}) {
  const { indent = ' ', includeEmptyLines = false } = options;

  if (count <= 0) {
    return string;
  }

  const regex = includeEmptyLines ? /^/gm : /^(?!\s*$)/gm;

  return string.replace(regex, indent.repeat(count));
}
