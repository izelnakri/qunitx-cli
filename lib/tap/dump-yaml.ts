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
// Also covers single-letter YAML 1.1 booleans: y/Y → true, n/N → false
const NEEDS_QUOTING =
  /^$|^(null|true|false|~|yes|no|on|off|y|n)$|^[{[!|>'"#%@`]|^[-?:](\s|$)|^---|^[-+]?(\d|\.\d)|^\d{4}-\d{2}-\d{2}|: |#/i;

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
    return '\n' + value.map((item) => `${next}- ${dumpValue(item, next)}`).join('\n');
  }
  // Plain object
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  const next = `${indent}  `;
  return (
    '\n' +
    entries
      .map(([entryKey, entryValue]) => `${next}${entryKey}: ${dumpValue(entryValue, next)}`)
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
  at,
}: {
  name: string;
  actual: unknown;
  expected: unknown;
  message: string | null;
  stack: string | null;
  at: string | null;
}): string {
  return (
    `name: ${dumpString(name, '')}\n` +
    yamlLine('actual', actual) +
    yamlLine('expected', expected) +
    yamlLine('message', message) +
    yamlLine('stack', stack) +
    yamlLine('at', at)
  );
}

export { dumpYaml as default };
