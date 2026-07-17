import fs from 'node:fs/promises';
import { parseTestDeclarations } from './parse-test-declarations.ts';
import type { TestDeclaration, DeclarationScan } from './parse-test-declarations.ts';

/**
 * One thing a `file#34` target selects. `test` omitted means "this module and everything nested
 * under it" — used for module targets, and as the fallback when a test's name is computed and so
 * cannot be matched exactly.
 */
export interface QUnitSelector {
  /** Full module path, ' > '-joined. '' for a top-level test. */
  module: string;
  /** Exact test name; omitted to select the whole module and its nested children. */
  test?: string;
}

/** Result of resolving a file's line targets into selectors, plus any diagnostics to surface. */
export interface LineTargetResolution {
  /** Selectors to apply, or null to run the whole file unfiltered. */
  selectors: QUnitSelector[] | null;
  /** `#`-prefixed lines to print — always explains why a target did not narrow as asked. */
  warnings: string[];
}

/**
 * Resolves `file#34` line targets into exact QUnit selections.
 *
 * A line resolves to the innermost declaration spanning it. Landing in a `test(...)` selects that
 * test; landing in a `module(...)` but outside every test selects the whole module. Anything that
 * cannot be resolved degrades — to the enclosing module, or to the whole file — and says so,
 * rather than failing the run.
 */
export async function resolveLineTargets(
  filePath: string,
  lines: number[],
  displayPath: string = filePath,
): Promise<LineTargetResolution> {
  const source = await fs.readFile(filePath, 'utf8').catch(() => null);
  if (source === null) {
    return {
      selectors: null,
      warnings: [`could not read ${displayPath} — running the whole file`],
    };
  }

  const scan = await parseTestDeclarations(source, filePath);
  if (!scan) {
    return {
      selectors: null,
      warnings: [`could not parse ${displayPath} — running the whole file`],
    };
  }

  return selectorsFromScan(scan, lines, displayPath);
}

/**
 * Resolves line targets against an ALREADY-parsed scan. Split out so `--search`, which has scanned
 * every file for its listing, can resolve line targets without reading and esbuild-transforming
 * those files a second time.
 */
export function selectorsFromScan(
  scan: DeclarationScan,
  lines: number[],
  displayPath: string,
): LineTargetResolution {
  const { declarations } = scan;
  const selectors: QUnitSelector[] = [];
  const warnings: string[] = [];
  if (scan.hasOnly) {
    warnings.push(
      `${displayPath} calls only() — QUnit ignores every other test in the file, so a line target may match nothing`,
    );
  }

  for (const line of lines) {
    const index = innermostAt(declarations, line);
    if (index === null) {
      warnings.push(`no test or module found at ${displayPath}#${line} — running the whole file`);
      return { selectors: null, warnings };
    }

    const declaration = declarations[index];
    if (declaration.kind === 'test' && declaration.name === null) {
      // A computed name (test(`case ${i}`)) can't be matched exactly. The enclosing module is the
      // tightest honest answer; without one, there is nothing to narrow to.
      const parent = declaration.parent;
      if (parent === null) {
        warnings.push(
          `the test at ${displayPath}#${line} has a computed name — running the whole file`,
        );
        return { selectors: null, warnings };
      }
      warnings.push(
        `the test at ${displayPath}#${line} has a computed name — running its module instead`,
      );
      selectors.push({ module: modulePath(declarations, parent) });
    } else if (declaration.kind === 'test') {
      selectors.push({
        module: declaration.parent === null ? '' : modulePath(declarations, declaration.parent),
        test: declaration.name!,
      });
    } else if (declaration.name === null) {
      warnings.push(
        `the module at ${displayPath}#${line} has a computed name — running the whole file`,
      );
      return { selectors: null, warnings };
    } else {
      selectors.push({ module: modulePath(declarations, index) });
    }
  }

  return { selectors, warnings };
}

export { resolveLineTargets as default };

/**
 * The innermost declaration spanning `line`. Ties break toward the latest start, which is the
 * deepest declaration: a test's range always starts after the module that contains it.
 */
function innermostAt(declarations: TestDeclaration[], line: number): number | null {
  let best: number | null = null;
  declarations.forEach((declaration, index) => {
    if (line < declaration.startLine || line > declaration.endLine) return;
    if (best === null || declaration.startLine >= declarations[best].startLine) {
      best = index;
    }
  });

  return best;
}

/** Walks up `parent` links to build QUnit's ' > '-joined module name. */
function modulePath(declarations: TestDeclaration[], index: number): string {
  const names: string[] = [];
  let current: number | null = index;
  while (current !== null) {
    const declaration: TestDeclaration = declarations[current];
    // A computed module name breaks the path; '' keeps the join honest rather than inventing one.
    names.unshift(declaration.name ?? '');
    current = declaration.parent;
  }

  return names.join(' > ');
}
