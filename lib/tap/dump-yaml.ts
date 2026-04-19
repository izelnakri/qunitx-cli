/**
 * Minimal YAML serializer for TAP assertion failure blocks.
 * Handles the fixed schema: { name, actual, expected, message, stack, at }.
 * Values for actual/expected are pre-sanitized via JSON.parse(JSON.stringify(...)).
 */

// Single compiled regex covering all cases where a plain YAML scalar would be misread:
// - YAML reserved words (null, true, false, ~, yes, no, on, off — case-insensitive)
// - Starts with a YAML indicator: { [ ! | > ' " % @ `
// - Block indicators that need a space: - ? : at start of string
// - Document separator: ---
// - Looks like a number (integer, float, hex, octal, scientific)
// - Timestamp-like strings that YAML 1.1 auto-casts to Date
// - Contains ': ' (key–value) or '#' anywhere (comment)
// - Empty string
// - Starts with whitespace (would render as "key:   value" with ambiguous extra spaces)
// Also covers single-letter YAML 1.1 booleans: y/Y → true, n/N → false
const NEEDS_QUOTING =
  /^$|^\s|^(null|true|false|~|yes|no|on|off|y|n)$|^[{[!|>'"#%@`]|^[-?:](\s|$)|^---|^[-+]?(\d|\.\d)|^\d{4}-\d{2}-\d{2}|: |#/i;

function needsQuoting(str: string): boolean {
  return NEEDS_QUOTING.test(str);
}

function dumpString(str: string, indent: string): string {
  if (str === '') return "''";
  if (str.includes('\n')) {
    // Block scalar |- (strip trailing newline), each line indented by current indent + 2
    return '|-\n' + str.replace(/^/gm, `${indent}  `);
  }
  if (needsQuoting(str)) return `'${str.replace(/'/g, "''")}'`;
  return str;
}

function dumpValue(value: unknown, indent: string): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return dumpString(value, indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const next = `${indent}  `;
    return (
      '\n' +
      value
        .map((item) => {
          const v = dumpValue(item, next);
          // Avoid trailing space before block values: "-\n  key: val" not "- \n  key: val"
          return v[0] === '\n' ? `${next}-${v}` : `${next}- ${v}`;
        })
        .join('\n')
    );
  }
  // Plain object
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  const next = `${indent}  `;
  return (
    '\n' +
    entries
      .map(([entryKey, entryValue]) => {
        const v = dumpValue(entryValue, next);
        // Avoid trailing space before block values: "key:\n  val" not "key: \n  val"
        return v[0] === '\n' ? `${next}${entryKey}:${v}` : `${next}${entryKey}: ${v}`;
      })
      .join('\n')
  );
}

// Emits `key: value\n` or `key:\n  ...\n` — no trailing space before block scalars.
function yamlLine(key: string, value: unknown): string {
  const serialized = dumpValue(value, '');
  return serialized[0] === '\n' ? `${key}:${serialized}\n` : `${key}: ${serialized}\n`;
}

/**
 * Serializes the fixed TAP assertion object to a YAML string.
 * Uses a template literal (no Object.entries overhead) for the known top-level keys.
 * @returns {string}
 */
export function dumpYaml({
  name,
  actual,
  expected,
  message,
  stack,
  source,
  at,
}: {
  name: string;
  actual: unknown;
  expected: unknown;
  message: string | null;
  stack: string | null;
  source: string | null;
  at: string | null;
}): string {
  // actual and expected are always emitted — they are the core comparison data.
  // message, stack, source, and at are supplementary context: omit when null to reduce noise.
  return (
    `name: ${dumpString(name, '')}\n` +
    yamlLine('actual', actual) +
    yamlLine('expected', expected) +
    (message !== null ? yamlLine('message', message) : '') +
    (stack !== null ? yamlLine('stack', stack) : '') +
    (source !== null ? yamlLine('source', source) : '') +
    (at !== null ? yamlLine('at', at) : '')
  );
}

export { dumpYaml as default };
