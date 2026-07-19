import path from 'node:path';
import esbuild from 'esbuild';
import { parseSourceMap } from '../utils/source-map-decoder.ts';
import type { SourceMapDecoder } from '../utils/source-map-decoder.ts';

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
    decoder = parseSourceMap(transformed.map, path.dirname(filePath));
  } catch {
    return null;
  }

  const tokens = tokenize(transformed.code);
  const { declarations, hasOnly } = collectDeclarations(tokens);

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

interface Token {
  type: 'ident' | 'punct' | 'string' | 'other';
  value: string;
  line: number;
}

/**
 * Lexes the transform output far enough to find call expressions: identifiers, punctuation and
 * string literals, with comments / template literals / regex literals consumed and discarded.
 * Template literals collapse to a single 'other' token, so `test(\`x ${i}\`)` reads as a call with
 * a non-literal name rather than a literal one.
 */
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let index = 0;

  while (index < code.length) {
    const char = code[index];

    if (char === '\n') {
      line++;
      index++;
    } else if (char === ' ' || char === '\t' || char === '\r') {
      index++;
    } else if (char === '/' && code[index + 1] === '/') {
      while (index < code.length && code[index] !== '\n') index++;
    } else if (char === '/' && code[index + 1] === '*') {
      index += 2;
      while (index < code.length && !(code[index] === '*' && code[index + 1] === '/')) {
        if (code[index] === '\n') line++;
        index++;
      }
      index += 2;
    } else if (char === '"' || char === "'") {
      const startLine = line;
      const [value, next] = readString(code, index);
      index = next;
      tokens.push({ type: 'string', value, line: startLine });
    } else if (char === '`') {
      const startLine = line;
      const [hasSubstitution, next, lines] = readTemplate(code, index);
      const raw = code.slice(index + 1, next - 1);
      line += lines;
      index = next;
      // A template with no ${} is as literal as a quoted string.
      tokens.push(
        hasSubstitution
          ? { type: 'other', value: '`', line: startLine }
          : { type: 'string', value: raw, line: startLine },
      );
    } else if (char === '/' && regexAllowedAfter(tokens)) {
      const [next, lines] = readRegex(code, index);
      line += lines;
      index = next;
      tokens.push({ type: 'other', value: '/', line });
    } else if (isIdentStart(char)) {
      let end = index;
      while (end < code.length && isIdentPart(code[end])) end++;
      tokens.push({ type: 'ident', value: code.slice(index, end), line });
      index = end;
    } else if (char >= '0' && char <= '9') {
      let end = index;
      while (end < code.length && /[0-9a-fA-FxXoObBnN._]/.test(code[end])) end++;
      tokens.push({ type: 'other', value: code.slice(index, end), line });
      index = end;
    } else {
      tokens.push({ type: 'punct', value: char, line });
      index++;
    }
  }

  return tokens;
}

function readString(code: string, start: number): [value: string, next: number] {
  const quote = code[start];
  let value = '';
  let index = start + 1;
  while (index < code.length && code[index] !== quote) {
    if (code[index] === '\\') {
      value += unescape(code[index + 1]);
      index += 2;
    } else {
      value += code[index];
      index++;
    }
  }

  return [value, index + 1];
}

function unescape(char: string): string {
  if (char === 'n') return '\n';
  else if (char === 't') return '\t';
  else if (char === 'r') return '\r';

  return char;
}

/** Walks a template literal, tracking `${}` nesting so a nested `` ` `` or `}` cannot end it early. */
function readTemplate(
  code: string,
  start: number,
): [hasSubstitution: boolean, next: number, lines: number] {
  let index = start + 1;
  let lines = 0;
  let hasSubstitution = false;
  while (index < code.length && code[index] !== '`') {
    if (code[index] === '\\') {
      index += 2;
    } else if (code[index] === '$' && code[index + 1] === '{') {
      hasSubstitution = true;
      index += 2;
      let depth = 1;
      while (index < code.length && depth > 0) {
        if (code[index] === '\n') lines++;
        else if (code[index] === '{') depth++;
        else if (code[index] === '}') depth--;
        else if (code[index] === '`') {
          const [, next, nestedLines] = readTemplate(code, index);
          lines += nestedLines;
          index = next;
          continue;
        }
        index++;
      }
    } else {
      if (code[index] === '\n') lines++;
      index++;
    }
  }

  return [hasSubstitution, index + 1, lines];
}

function readRegex(code: string, start: number): [next: number, lines: number] {
  let index = start + 1;
  let inClass = false;
  while (index < code.length) {
    const char = code[index];
    if (char === '\\') {
      index += 2;
      continue;
    } else if (char === '[') {
      inClass = true;
    } else if (char === ']') {
      inClass = false;
    } else if (char === '/' && !inClass) {
      index++;
      break;
    } else if (char === '\n') {
      break;
    }
    index++;
  }
  while (index < code.length && /[a-z]/.test(code[index])) index++;

  return [index, 0];
}

/**
 * Regex-vs-divide: a `/` starts a regex unless the previous token could end an expression.
 * `return /x/` is a regex; `a / b` and `f() / 2` are division.
 */
function regexAllowedAfter(tokens: Token[]): boolean {
  const previous = tokens.at(-1);
  if (!previous) return true;
  else if (previous.type === 'string' || previous.type === 'other') return false;
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
 * Resolves which local identifiers are qunitx declarators, then walks the token stream for calls
 * on them. Binding to the `qunitx` import (rather than matching the bare names) keeps a project's
 * own `skip()` or `module()` helper from being mistaken for a test declaration.
 */
function collectDeclarations(tokens: Token[]): DeclarationScan {
  const { tests, modules, namespaces } = resolveDeclaratorNames(tokens);
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

/**
 * Reads `import … from 'qunitx'` to learn the local name of each declarator, honouring aliases.
 * `QUnit` is always treated as a namespace: it is a global when QUnit is loaded via a script tag.
 */
function resolveDeclaratorNames(tokens: Token[]): {
  tests: Map<string, string>;
  modules: Set<string>;
  namespaces: Set<string>;
} {
  const tests = new Map<string, string>();
  const modules = new Set<string>();
  const namespaces = new Set<string>(['QUnit']);

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== 'import' || tokens[i].type !== 'ident') continue;
    const clauseEnd = tokens.findIndex((token, index) => index > i && token.value === 'from');
    if (clauseEnd === -1 || tokens[clauseEnd + 1]?.value !== 'qunitx') continue;

    for (let j = i + 1; j < clauseEnd; j++) {
      const token = tokens[j];
      if (token.type !== 'ident') continue;
      if (token.value === 'as') continue;
      // `import QUnit from 'qunitx'` / `import * as QUnit from 'qunitx'` — a namespace binding is
      // the only ident not preceded by `{` or `,` inside the clause.
      const insideBraces = tokens.slice(i + 1, j).some((t) => t.value === '{');
      const local = tokens[j + 1]?.value === 'as' ? tokens[j + 2].value : token.value;
      if (!insideBraces) {
        namespaces.add(local);
      } else if (token.value === 'module') {
        modules.add(local);
      } else if (isTestMember(token.value)) {
        tests.set(local, token.value);
      }
      if (tokens[j + 1]?.value === 'as') j += 2;
    }
  }

  return { tests, modules, namespaces };
}
