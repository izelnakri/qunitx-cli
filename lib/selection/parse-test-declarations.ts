import path from 'node:path';
import esbuild from 'esbuild';
import * as SourceMap from '../utils/source-map.ts';
import type { SourceMapDecoder } from '../utils/source-map.ts';

/** A `test(...)` or `module(...)` call found in a test file, in 1-based source lines. */
export interface TestDeclaration {
  /** Whether this is a `test(...)` or a `module(...)` call. */
  kind: 'test' | 'module';
  /** The literal first argument, or null when it is computed (`test(\`case ${i}\`)`). */
  name: string | null;
  /** Line of the callee. */
  startLine: number;
  /** Line of the call's closing paren — so [startLine, endLine] spans the whole body. */
  endLine: number;
  /** Index into `declarations` of the innermost enclosing module, or null at the top level. */
  parent: number | null;
}

/** Every declaration found in a file, plus whether it uses `only()`. */
export interface DeclarationScan {
  /** All test/module declarations, sorted by start line, with `parent` links resolved. */
  declarations: TestDeclaration[];
  /** True when the file calls `only()`, which makes QUnit ignore every other test in the run. */
  hasOnly: boolean;
}

const DECLARATOR_MEMBERS = new Set(['only', 'skip', 'todo', 'each']);
// Keywords after which a `/` begins a regex, not a division — `return /x/`, `typeof /x/`. Any
// other identifier ends an expression, so a following `/` there is division (`count / 2`).
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
]);
const LOADERS: Record<string, esbuild.Loader> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.cjs': 'js',
  '.js': 'js',
};

/**
 * Finds every `test(...)` / `module(...)` declaration in a test file, with the source line range
 * each one spans — enough to answer "which test is at line 34?".
 *
 * The file is run through `esbuild.transform` first and the *output* is lexed, then mapped back
 * through the transform's source map. That removes TS and JSX syntax before lexing, which matters:
 * JSX text is not JS, so an apostrophe in `<p>it's fine</p>` would open a string literal in a
 * source-level lexer and corrupt every brace depth after it. What is left to lex is comments,
 * strings, template literals and the regex-vs-divide ambiguity.
 *
 * Returns null when the file cannot be parsed — callers fall back to running the whole file.
 */
export async function parseTestDeclarations(
  source: string,
  filePath: string,
): Promise<DeclarationScan | null> {
  let transformed: esbuild.TransformResult;
  try {
    transformed = await esbuild.transform(source, {
      loader: LOADERS[path.extname(filePath)] ?? 'tsx',
      jsx: 'automatic',
      sourcefile: filePath,
      sourcemap: 'external',
      sourcesContent: false,
      logLevel: 'silent',
    });
  } catch {
    return null;
  }

  let decoder: SourceMapDecoder;
  try {
    decoder = SourceMap.parse(transformed.map, path.dirname(filePath));
  } catch {
    return null;
  }

  const tokens = tokenize(transformed.code);
  const { declarations, hasOnly } = collectQUnitDeclarations(tokens);

  // Generated → source. A declaration's callee line maps to where the user wrote it; the closing
  // paren's line also carries the last body statement, so the closer is the highest of the two.
  const mapped: TestDeclaration[] = [];
  for (const declaration of declarations) {
    const startLine = mapLine(decoder, declaration.startLine, 'min');
    const endLine = mapLine(decoder, declaration.endLine, 'max');
    if (startLine === null || endLine === null) continue;
    mapped.push({ ...declaration, startLine, endLine: Math.max(startLine, endLine) });
  }

  mapped.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  assignParents(mapped);

  return { declarations: mapped, hasOnly };
}

export { parseTestDeclarations as default };

/** Innermost enclosing module wins, so a test inside a module resolves to `Module > test`. */
function assignParents(declarations: TestDeclaration[]): void {
  declarations.forEach((declaration, index) => {
    let parent: number | null = null;
    for (let i = 0; i < index; i++) {
      const candidate = declarations[i];
      if (
        candidate.kind === 'module' &&
        candidate.startLine <= declaration.startLine &&
        candidate.endLine >= declaration.endLine &&
        (parent === null || declarations[parent].startLine <= candidate.startLine)
      ) {
        parent = i;
      }
    }
    declaration.parent = parent;
  });
}

/**
 * Maps a 1-based generated line to a 1-based source line. `pick` selects which of the line's
 * segments wins when it carries several — 'min' for a declaration's start, 'max' for its closer.
 * Falls forward to the next mapped generated line, since esbuild emits no segment for a line it
 * produced with no source of its own.
 */
function mapLine(
  decoder: SourceMapDecoder,
  generatedLine: number,
  pick: 'min' | 'max',
): number | null {
  for (let line = generatedLine - 1; line < decoder.segmentsByLine.length; line++) {
    const segments = decoder.segmentsByLine[line];
    if (!segments?.length) continue;
    const lines = segments.map((segment) => segment.sourceLine);

    return (pick === 'min' ? Math.min(...lines) : Math.max(...lines)) + 1;
  }

  return null;
}

/**
 * One lexed token. The four kinds exist only to answer what collectQUnitDeclarations asks: "is this a
 * callee name?", "is this a `.` or `(`?", "is this a literal name?", and — for the regex-vs-divide
 * rule — "did an expression just end?".
 */
interface Token {
  /**
   * - `ident`  — an identifier run, INCLUDING keywords (`test`, `QUnit`, `import`, `return`);
   *              matched against the resolved declarator names and REGEX_PRECEDING_KEYWORDS.
   * - `punct`  — exactly one punctuation character, never merged, so paren depth and member
   *              access can be matched by exact `value` comparison (`.`, `(`, `)`).
   * - `string` — a string literal's COOKED value, or a template with no `${}`. The only kind a
   *              declaration name can be read from.
   * - `opaque` — consumed but deliberately not modelled: a number, a regex literal, or a template
   *              WITH a `${}`. Its `value` is a sentinel (the digits, `/`, a backtick), not
   *              content. Like `string` it ENDS an expression, so a following `/` is division.
   */
  type: 'ident' | 'punct' | 'string' | 'opaque';
  /** The token text — cooked for `string`, raw or a sentinel otherwise. */
  value: string;
  /** 1-based line in the TRANSFORMED output; mapped back to source lines by mapLine(). */
  line: number;
}

/**
 * A mutable cursor threaded through the readers below. Each reader advances `pos` (and `line`, for
 * spans that cross newlines) in place and returns just its token value — no per-token tuple to
 * allocate or destructure, and every reader has one shape: consume from the scanner, return the
 * value (or nothing, for spans that are discarded).
 */
interface Scanner {
  code: string;
  pos: number;
  line: number;
}

/**
 * Lexes the transform output far enough to find call expressions: identifiers, punctuation and
 * string literals, with comments / template literals / regex literals consumed and discarded.
 * Template literals collapse to a single 'opaque' token, so `test(\`x ${i}\`)` reads as a call with
 * a non-literal name rather than a literal one.
 *
 * The body is a flat dispatch table: match the token kind on the first character, then hand off to
 * the matching reader. `line` is captured up front — a token records where it *starts*, which holds
 * even when its reader spans several lines.
 */
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  const scanner: Scanner = { code, pos: 0, line: 1 };

  while (scanner.pos < code.length) {
    const char = code[scanner.pos];
    const line = scanner.line;

    if (char === '\n') {
      scanner.line++;
      scanner.pos++;
    } else if (char === ' ' || char === '\t' || char === '\r') {
      scanner.pos++;
    } else if (char === '/' && code[scanner.pos + 1] === '/') {
      skipLineComment(scanner);
    } else if (char === '/' && code[scanner.pos + 1] === '*') {
      skipBlockComment(scanner);
    } else if (char === '"' || char === "'") {
      tokens.push({ type: 'string', value: readString(scanner), line });
    } else if (char === '`') {
      // readTemplate returns null for a template with a ${}; a substitution-free one is as literal
      // as a quoted string.
      const raw = readTemplate(scanner);
      tokens.push(
        raw === null ? { type: 'opaque', value: '`', line } : { type: 'string', value: raw, line },
      );
    } else if (char === '/' && regexAllowedAfter(tokens)) {
      readRegex(scanner);
      tokens.push({ type: 'opaque', value: '/', line });
    } else if (isIdentStart(char)) {
      tokens.push({ type: 'ident', value: readIdentifier(scanner), line });
    } else if (char >= '0' && char <= '9') {
      tokens.push({ type: 'opaque', value: readNumber(scanner), line });
    } else {
      tokens.push({ type: 'punct', value: char, line });
      scanner.pos++;
    }
  }

  return tokens;
}

/** Consumes a `// …` line comment up to (not including) the newline, which the caller counts. */
function skipLineComment(scanner: Scanner): void {
  const { code } = scanner;
  let pos = scanner.pos;
  while (pos < code.length && code[pos] !== '\n') pos++;
  scanner.pos = pos;
}

/** Consumes a block comment, counting the newlines inside it. */
function skipBlockComment(scanner: Scanner): void {
  const { code } = scanner;
  let pos = scanner.pos + 2;
  let line = scanner.line;
  while (pos < code.length && !(code[pos] === '*' && code[pos + 1] === '/')) {
    if (code[pos] === '\n') line++;
    pos++;
  }
  scanner.pos = pos + 2;
  scanner.line = line;
}

function readString(scanner: Scanner): string {
  const { code } = scanner;
  const quote = code[scanner.pos];
  let value = '';
  let pos = scanner.pos + 1;
  let line = scanner.line;
  while (pos < code.length && code[pos] !== quote) {
    if (code[pos] === '\\') {
      // A line continuation ('a\<newline>') swallows a real newline; count it so `line` stays in
      // sync for later declarations. Rare in esbuild output, but the guard is free.
      if (code[pos + 1] === '\n') line++;
      value += unescape(code[pos + 1]);
      pos += 2;
    } else {
      value += code[pos];
      pos++;
    }
  }
  scanner.pos = pos + 1;
  scanner.line = line;

  return value;
}

function unescape(char: string): string {
  if (char === 'n') return '\n';
  else if (char === 't') return '\t';
  else if (char === 'r') return '\r';

  return char;
}

/**
 * Walks a template literal, tracking `${}` nesting so a nested backtick or `}` cannot end it early.
 * Returns the raw text of a substitution-free template, or null when it contains a `${}`. Unlike the
 * other readers it mutates the scanner directly (no `pos`/`line` locals) so the recursive
 * nested-template call composes without threading state back and forth by hand.
 */
function readTemplate(scanner: Scanner): string | null {
  const { code } = scanner;
  const start = scanner.pos;
  scanner.pos++;
  let hasSubstitution = false;
  while (scanner.pos < code.length && code[scanner.pos] !== '`') {
    if (code[scanner.pos] === '\\') {
      scanner.pos += 2;
    } else if (code[scanner.pos] === '$' && code[scanner.pos + 1] === '{') {
      hasSubstitution = true;
      scanner.pos += 2;
      let depth = 1;
      while (scanner.pos < code.length && depth > 0) {
        const char = code[scanner.pos];
        if (char === '\n') scanner.line++;
        else if (char === '{') depth++;
        else if (char === '}') depth--;
        else if (char === '`') {
          readTemplate(scanner);
          continue;
        }
        scanner.pos++;
      }
    } else {
      if (code[scanner.pos] === '\n') scanner.line++;
      scanner.pos++;
    }
  }
  const raw = code.slice(start + 1, scanner.pos);
  scanner.pos++;

  return hasSubstitution ? null : raw;
}

/** Consumes a regex literal, including its `[…]` classes (a `/` inside a class does not end it). */
function readRegex(scanner: Scanner): void {
  const { code } = scanner;
  let pos = scanner.pos + 1;
  let inClass = false;
  while (pos < code.length) {
    const char = code[pos];
    if (char === '\\') {
      pos += 2;
      continue;
    } else if (char === '[') {
      inClass = true;
    } else if (char === ']') {
      inClass = false;
    } else if (char === '/' && !inClass) {
      pos++;
      break;
    } else if (char === '\n') {
      break;
    }
    pos++;
  }
  while (pos < code.length && /[a-z]/.test(code[pos])) pos++;
  scanner.pos = pos;
}

/** Reads an identifier run (`[A-Za-z0-9_$]` after a valid start char). */
function readIdentifier(scanner: Scanner): string {
  const { code } = scanner;
  const start = scanner.pos;
  let pos = start;
  while (pos < code.length && isIdentPart(code[pos])) pos++;
  scanner.pos = pos;

  return code.slice(start, pos);
}

/** Reads a numeric literal run — the digits are irrelevant, only that it is one 'opaque' token. */
function readNumber(scanner: Scanner): string {
  const { code } = scanner;
  const start = scanner.pos;
  let pos = start;
  while (pos < code.length && /[0-9a-fA-FxXoObBnN._]/.test(code[pos])) pos++;
  scanner.pos = pos;

  return code.slice(start, pos);
}

/**
 * Regex-vs-divide: a `/` starts a regex unless the previous token could end an expression.
 * `return /x/` is a regex; `a / b` and `f() / 2` are division.
 */
function regexAllowedAfter(tokens: Token[]): boolean {
  const previous = tokens.at(-1);
  if (!previous) return true;
  else if (previous.type === 'string' || previous.type === 'opaque') return false;
  else if (previous.type === 'ident') return REGEX_PRECEDING_KEYWORDS.has(previous.value);
  else if (previous.type === 'punct') return !')]}'.includes(previous.value);

  return true;
}

function isIdentStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char);
}

function isIdentPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

/**
 * Walks the token stream for calls on the resolved qunitx declarators — `test(…)`, `module(…)`,
 * `QUnit.test.skip(…)` and friends. Only calls on names bound to qunitx count, so a project's own
 * `skip()` or `module()` helper is never mistaken for a test declaration.
 */
function collectQUnitDeclarations(tokens: Token[]): DeclarationScan {
  const { tests, modules, namespaces } = resolveQUnitDeclarators(tokens);
  const declarations: TestDeclaration[] = [];
  let hasOnly = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'ident') continue;

    let kind: 'test' | 'module' | null = null;
    let callAt = i + 1;

    if (namespaces.has(token.value) && tokens[i + 1]?.value === '.') {
      // QUnit.test(…) / QUnit.module.skip(…)
      const member = tokens[i + 2];
      if (member?.type !== 'ident') continue;
      kind = member.value === 'module' ? 'module' : isTestMember(member.value) ? 'test' : null;
      callAt = i + 3;
      if (tokens[i + 3]?.value === '.' && DECLARATOR_MEMBERS.has(tokens[i + 4]?.value)) {
        if (tokens[i + 4].value === 'only') hasOnly = true;
        callAt = i + 5;
      }
    } else if (tests.has(token.value) || modules.has(token.value)) {
      kind = modules.has(token.value) ? 'module' : 'test';
      if (tests.get(token.value) === 'only') hasOnly = true;
      if (tokens[i + 1]?.value === '.' && DECLARATOR_MEMBERS.has(tokens[i + 2]?.value)) {
        if (tokens[i + 2].value === 'only') hasOnly = true;
        callAt = i + 3;
      }
    }

    if (!kind || tokens[callAt]?.value !== '(') continue;
    // A property access or a bare reference is not a declaration: `test.skip` alone, `foo.test(…)`.
    if (tokens[i - 1]?.value === '.') continue;

    const closeAt = findMatchingParen(tokens, callAt);
    if (closeAt === -1) continue;

    const nameToken = tokens[callAt + 1];
    declarations.push({
      kind,
      name: nameToken?.type === 'string' ? nameToken.value : null,
      startLine: token.line,
      endLine: tokens[closeAt].line,
      parent: null,
    });
    i = callAt;
  }

  return { declarations, hasOnly };
}

function isTestMember(value: string): boolean {
  return value === 'test' || value === 'only' || value === 'skip' || value === 'todo';
}

function findMatchingParen(tokens: Token[], openAt: number): number {
  let depth = 0;
  for (let i = openAt; i < tokens.length; i++) {
    const { value, type } = tokens[i];
    if (type !== 'punct') continue;
    if (value === '(') depth++;
    else if (value === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/** The local names that refer to qunitx's declarators in one file. */
interface QUnitDeclarators {
  /** Local name → which qunitx export it is (`test`, `only`, `skip`, `todo`). */
  tests: Map<string, string>;
  /** Local names bound to qunitx's `module`. */
  modules: Set<string>;
  /** Local names bound to the whole namespace (`QUnit.test(…)`), plus the `QUnit` global. */
  namespaces: Set<string>;
}

/** One name a qunitx import clause brings into scope. */
interface DeclaratorBinding {
  /** The name used in this file, after any `as` alias. */
  local: string;
  /** The qunitx export it points at (`test`, `module`, …); the whole module for a namespace. */
  imported: string;
  /** True for `import QUnit from` / `import * as Q from` — a binding for the whole namespace. */
  namespace: boolean;
}

/**
 * Reads `import … from 'qunitx'` to learn the local name of each declarator, honouring aliases.
 * `QUnit` is always treated as a namespace: it is a global when QUnit is loaded via a script tag.
 *
 * Binding to the import (rather than matching bare names) is what keeps a project's own `skip()`
 * or `module()` helper from being mistaken for a qunitx declarator.
 */
function resolveQUnitDeclarators(tokens: Token[]): QUnitDeclarators {
  return qunitxImportClauses(tokens)
    .flatMap((clause) => clauseBindings(tokens, clause))
    .reduce<QUnitDeclarators>(
      (declarators, { local, imported, namespace }) => {
        if (namespace) {
          declarators.namespaces.add(local);
        } else if (imported === 'module') {
          declarators.modules.add(local);
        } else if (isTestMember(imported)) {
          declarators.tests.set(local, imported);
        }

        return declarators;
      },
      { tests: new Map(), modules: new Set(), namespaces: new Set(['QUnit']) },
    );
}

/**
 * Token ranges `[afterImport, beforeFrom)` of every `import … from 'qunitx'` clause. The scan for
 * `from` starts at the `import` rather than using findIndex, which would rescan the whole prefix.
 */
function qunitxImportClauses(tokens: Token[]): Array<[start: number, end: number]> {
  const clauses: Array<[number, number]> = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'ident' || tokens[i].value !== 'import') continue;
    let from = -1;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].type === 'ident' && tokens[j].value === 'from') {
        from = j;
        break;
      }
    }
    if (from === -1) break;
    if (tokens[from + 1]?.value === 'qunitx') clauses.push([i + 1, from]);
    i = from;
  }

  return clauses;
}

/**
 * The bindings one clause introduces. `insideBraces` is carried along the walk: a namespace binding
 * is the only identifier that appears before the clause's `{`.
 */
function clauseBindings(tokens: Token[], [start, end]: [number, number]): DeclaratorBinding[] {
  const bindings: DeclaratorBinding[] = [];
  let insideBraces = false;

  for (let i = start; i < end; i++) {
    const token = tokens[i];
    if (token.value === '{') {
      insideBraces = true;
    } else if (token.type === 'ident' && token.value !== 'as') {
      const aliased = tokens[i + 1]?.value === 'as';
      bindings.push({
        local: aliased ? tokens[i + 2].value : token.value,
        imported: token.value,
        namespace: !insideBraces,
      });
      if (aliased) i += 2;
    }
  }

  return bindings;
}
