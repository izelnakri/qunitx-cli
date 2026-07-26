/**
 * Prepends `count` repetitions of `indent` (default: one space) to each non-empty line of `string`.
 *
 * ```ts
 * indentString('hello\nworld', 2); // '  hello\n  world'
 * indentString('a\n\nb', 1, { indent: '\t', includeEmptyLines: true }); // '\ta\n\t\n\tb'
 * ```
 * @returns {string}
 */
export function indentString(
  string: string,
  count: number = 1,
  options: { indent?: string; includeEmptyLines?: boolean } = {},
): string {
  const { indent = ' ', includeEmptyLines = false } = options;

  if (count <= 0) {
    return string;
  }

  const regex = includeEmptyLines ? /^/gm : /^(?!\s*$)/gm;

  return string.replace(regex, indent.repeat(count));
}
