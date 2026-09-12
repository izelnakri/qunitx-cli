// What a value would be called in TypeScript, worked out from the value itself. Runs in the PAGE
// (as source text, like `inspect.ts`), because the values it describes are the page's: a DOM node,
// a class instance, whatever a test just built.
//
// That is a constraint, not a detail: this must stay ONE self-contained function with no imports
// and no references to anything outside it, because `Function.prototype.toString()` carries none of
// that across. Helpers live inside it.

/**
 * A TypeScript type for a runtime value.
 *
 * Structural, because that is what is knowable here: the page holds values, not declarations, and
 * `const a: string = 'x'` left no trace of the annotation by the time it is a string. What a
 * WRITTEN type looks like is a question for the file it was written in — the caller asks that
 * first and only falls back to this.
 *
 * Names classes and host objects rather than expanding them: `HTMLDivElement` says more than the
 * two hundred properties it has, and the same is true of anything with a constructor of its own.
 *
 * ```ts
 * import { describeType } from './types.ts';
 *
 * describeType('hi'); // 'string'
 * describeType([1, 2]); // 'number[]'
 * describeType({ a: 1, b: 'x' }); // '{ a: number; b: string }'
 * describeType([1, 'x']); // '(number | string)[]'
 * describeType(new Map([['k', 1]])); // 'Map<string, number>'
 * describeType(null); // 'null'
 * ```
 */
export function describeType(value: unknown, depth: number = 2): string {
  // Enough of a shape to recognise it; past this it is noise, and `object` is the honest answer.
  const KEYS = 12;
  const SAMPLED = 20;

  return of(value, depth);

  function of(subject: unknown, left: number): string {
    if (subject === null) return 'null';
    if (typeof subject !== 'object' && typeof subject !== 'function') return typeof subject;
    if (typeof subject === 'function') return signatureOf(subject as (...args: never[]) => unknown);
    if (left < 0) return 'object';

    if (Array.isArray(subject)) {
      const inside = union(subject.slice(0, SAMPLED).map((item) => of(item, left - 1)));

      return subject.length === 0
        ? 'unknown[]'
        : `${inside.includes('|') ? `(${inside})` : inside}[]`;
    }
    if (subject instanceof Map) return `Map<${pairs(subject, left)}>`;
    if (subject instanceof Set) {
      return `Set<${union([...subject].slice(0, SAMPLED).map((item) => of(item, left - 1))) || 'unknown'}>`;
    }
    if (subject instanceof Promise) return 'Promise<unknown>';

    // A prototype of its own means a name of its own, and the name is the useful answer.
    const named = Object.getPrototypeOf(subject) as { constructor?: { name?: string } } | null;
    const constructor = named?.constructor?.name;
    if (constructor !== undefined && constructor !== 'Object') return constructor;
    if (named === null) return 'object';

    return shapeOf(subject as Record<string, unknown>, left);
  }

  /** `{ a: number; b: string }`, to the depth left, and `{}` for one with nothing in it. */
  function shapeOf(subject: Record<string, unknown>, left: number): string {
    const keys = Object.keys(subject);
    const shown = keys
      .slice(0, KEYS)
      .map((key) => `${readable(key)}: ${of(subject[key], left - 1)}`);
    if (keys.length > KEYS) shown.push('…');

    return shown.length === 0 ? '{}' : `{ ${shown.join('; ')} }`;
  }

  /** What a function's own source says it takes, or `Function` where it will not say. */
  function signatureOf(subject: (...args: never[]) => unknown): string {
    const written = String(subject);
    // A native function's source is `function max() { [native code] }` — empty parentheses that
    // mean "not telling", not "takes nothing".
    if (written.includes('[native code]')) return 'Function';
    const opens = written.indexOf('(');
    const closes = written.indexOf(')', opens);
    if (opens === -1 || closes === -1 || written.slice(opens, closes).includes('{')) {
      return 'Function';
    }
    const between = written.slice(opens + 1, closes).trim();
    const parameters = between === '' ? [] : between.split(',').map((one) => one.trim());

    return `(${parameters.map((one) => `${one}: unknown`).join(', ')}) => unknown`;
  }

  function pairs(subject: Map<unknown, unknown>, left: number): string {
    const entries = [...subject].slice(0, SAMPLED);
    const keys = union(entries.map(([key]) => of(key, left - 1))) || 'unknown';

    return `${keys}, ${union(entries.map(([, held]) => of(held, left - 1))) || 'unknown'}`;
  }

  /** The distinct types, in the order first seen — a union nobody has to read twice. */
  function union(types: string[]): string {
    return [...new Set(types)].join(' | ');
  }

  /** A key that is not an identifier has to be quoted, exactly as it would be in a type. */
  function readable(key: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `'${key}'`;
  }
}
