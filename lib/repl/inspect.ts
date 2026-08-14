// The REPL's value renderer. Runs in BOTH processes: Node calls it directly on the primitives CDP
// returns by value, and the page gets it as source text (`inspect.toString()`) to render everything
// that only exists over there — a DOM node, a class instance, a live object graph. One function, so
// `{ a: 1 }` reads the same whichever side produced it.
//
// That second use is a constraint, not a detail: this must stay ONE self-contained function with no
// imports and no references to anything outside it, because `Function.prototype.toString()` carries
// none of that across. Helpers live inside it. (`lib/setup/ws-client.js` is injected the same way.)

/**
 * Renders a value the way the REPL prints it.
 *
 * Deliberately close to `util.inspect` — quoted strings, `[Function: name]`, `Map(1) {…}` — because
 * the audience is someone who types into a prompt and expects a JavaScript prompt's answers.
 * Composites that do not fit on one line are broken across several rather than truncated: a REPL
 * that hides the tail of your object is a REPL you stop trusting.
 *
 * ```ts
 * import { inspect } from './inspect.ts';
 *
 * inspect('hi'); // "'hi'" — quoted, so it cannot be confused with a bare identifier
 * inspect({ a: 1, b: [2, 3] }); // '{ a: 1, b: [ 2, 3 ] }'
 * inspect(new Map([['k', 1]])); // "Map(1) { 'k' => 1 }"
 * ```
 */
export function inspect(value: unknown, depth: number = 2): string {
  const seen = new Set<unknown>();
  // Beyond this a one-line rendering stops being readable, so composites break across lines.
  const WIDTH = 72;
  const MAX_ENTRIES = 100;
  const MAX_MARKUP = 300;

  return format(value, depth);

  function format(input: unknown, left: number): string {
    if (input === null) return 'null';
    if (input === undefined) return 'undefined';

    const type = typeof input;
    if (type === 'string') return quote(input as string);
    if (type === 'number') return Object.is(input, -0) ? '-0' : String(input);
    if (type === 'bigint') return `${input}n`;
    if (type === 'boolean' || type === 'symbol') return String(input);
    if (type === 'function') return formatFunction(input as (...args: unknown[]) => unknown);

    return formatObject(input as object, left);
  }

  function formatFunction(input: (...args: unknown[]) => unknown): string {
    const isClass = /^\s*class[\s{]/.test(Function.prototype.toString.call(input));
    const name = input.name;
    if (isClass) return name ? `[class ${name}]` : '[class (anonymous)]';

    return name ? `[Function: ${name}]` : '[Function (anonymous)]';
  }

  function formatObject(input: object, left: number): string {
    if (seen.has(input)) return '[Circular]';
    // An element is the one value whose useful rendering is its own source text — a prompt that
    // answered `HTMLDivElement {}` for `document.querySelector(…)` would be answering nothing.
    // Duck-typed rather than `instanceof Element`: there is no DOM in the process that also runs
    // this, and shape is the honest test across realms anyway.
    const element = input as { tagName?: unknown; outerHTML?: unknown };
    if (typeof element.tagName === 'string' && typeof element.outerHTML === 'string') {
      const markup = element.outerHTML;
      return markup.length > MAX_MARKUP ? `${markup.slice(0, MAX_MARKUP)}…` : markup;
    }
    if (input instanceof Error) return input.stack || `${input.name}: ${input.message}`;
    if (input instanceof Date) return isNaN(input.getTime()) ? 'Invalid Date' : input.toISOString();
    if (input instanceof RegExp) return String(input);
    // Settled-ness is not observable synchronously, so the terminal renders a top-level promise
    // from CDP's preview instead; this is what a promise nested inside something else looks like.
    if (input instanceof Promise) return 'Promise';

    const name = constructorName(input);
    if (left < 0) return Array.isArray(input) ? '[Array]' : `[${name || 'Object'}]`;

    seen.add(input);
    try {
      if (Array.isArray(input)) return wrap('[', entriesOfArray(input, left), ']', '');
      if (input instanceof Map)
        return wrap('{', entriesOfMap(input, left), '}', `Map(${input.size})`);
      if (input instanceof Set)
        return wrap('{', entriesOfSet(input, left), '}', `Set(${input.size})`);
      if (ArrayBuffer.isView(input) && !(input instanceof DataView)) {
        const items = entriesOfArray(Array.from(input as unknown as ArrayLike<unknown>), left);
        return wrap('[', items, ']', `${name}(${(input as unknown as ArrayLike<unknown>).length})`);
      }

      const prefix = name === 'Object' ? '' : name || '[Object: null prototype]';
      return wrap('{', entriesOfObject(input, left), '}', prefix);
    } finally {
      seen.delete(input);
    }
  }

  function entriesOfArray(input: ArrayLike<unknown>, left: number): string[] {
    const shown = Array.from(input)
      .slice(0, MAX_ENTRIES)
      .map((item) => format(item, left - 1));
    const hidden = input.length - shown.length;

    return hidden > 0 ? shown.concat(`… ${hidden} more items`) : shown;
  }

  function entriesOfMap(input: Map<unknown, unknown>, left: number): string[] {
    return Array.from(input.entries())
      .slice(0, MAX_ENTRIES)
      .map(([key, item]) => `${format(key, left - 1)} => ${format(item, left - 1)}`);
  }

  function entriesOfSet(input: Set<unknown>, left: number): string[] {
    return Array.from(input.values())
      .slice(0, MAX_ENTRIES)
      .map((item) => format(item, left - 1));
  }

  function entriesOfObject(input: object, left: number): string[] {
    return Object.keys(input)
      .slice(0, MAX_ENTRIES)
      .map((key) => {
        // A getter that throws is the object's business, not the prompt's: report it and move on
        // rather than failing the whole rendering.
        let rendered: string;
        try {
          rendered = format((input as Record<string, unknown>)[key], left - 1);
        } catch (error) {
          rendered = `[Getter threw: ${(error as Error)?.message ?? String(error)}]`;
        }

        return `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key)}: ${rendered}`;
      });
  }

  function wrap(open: string, entries: string[], close: string, prefix: string): string {
    const head = prefix ? `${prefix} ` : '';
    if (entries.length === 0) return prefix ? `${head}${open}${close}` : `${open}${close}`;
    const line = `${head}${open} ${entries.join(', ')} ${close}`;
    if (line.length <= WIDTH && !line.includes('\n')) return line;
    // One entry per line, every nested line indented with it, so a deep object stays readable.
    const body = entries.map((entry) => `  ${entry.split('\n').join('\n  ')}`).join(',\n');

    return `${head}${open}\n${body}\n${close}`;
  }

  function constructorName(input: object): string {
    const prototype = Object.getPrototypeOf(input);
    if (prototype === null) return '';

    return prototype.constructor?.name || 'Object';
  }

  function quote(input: string): string {
    const escaped = input
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      // Remaining C0 controls have no readable spelling, so they go out as \xNN.
      // deno-lint-ignore no-control-regex
      .replace(/[\x00-\x1f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);

    return `'${escaped}'`;
  }
}
