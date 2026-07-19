import fs from 'node:fs/promises';
import path from 'node:path';
import { parseTestDeclarations } from '../selection/parse-test-declarations.ts';
import { matchesQUnitFilter, qunitFullName } from '../selection/qunit-filter-match.ts';
import { selectorsFromScan } from '../selection/line-targets.ts';
import { blue, yellow } from '../utils/color.ts';
import type { TestDeclaration, DeclarationScan } from '../selection/parse-test-declarations.ts';
import type { QUnitSelector } from '../selection/line-targets.ts';
import type { Config } from '../types.ts';

/** One scanned file: its parsed declarations (null when unparseable) and the tests derived from them. */
interface ScannedFile {
  file: string;
  displayPath: string;
  scan: DeclarationScan | null;
  tests: FoundTest[];
  computed: number;
}

/** One test found by the static scan, named exactly as QUnit would name it. */
interface FoundTest {
  /** Absolute path of the file it was declared in — used to apply that file's line targets. */
  file: string;
  /** Module path, ' > '-joined; '' for a top-level test. */
  module: string;
  /** The test's own name. */
  testName: string;
  /** `"Module > Sub: test name"` — the string a filter matches against. */
  fullName: string;
  /** Where it is declared, `path#line`, ready to paste back as a line target. */
  location: string;
}

/**
 * `--search` / `-s` / `--print` / `-p` / `--preview`: list the tests the current selection matches,
 * without running them.
 *
 * The listing comes from the same static declaration scanner `file#line` targets use — no browser,
 * no bundle, no test execution — and matching goes through a port of QUnit's own filter that is
 * differential-tested against a real run, so the preview reflects what an actual run would select.
 * Every axis of the real run is honoured: the `-t`/`-m` expression, and `file#line` line targets
 * (resolved per file, exactly as a real run scopes each group).
 *
 * The trade-off of scanning instead of executing: a test whose name is computed
 * (``test(`case ${i}`)``) has no name until the browser runs it, so it cannot be listed. Those are
 * counted and reported rather than silently omitted.
 *
 * @returns the process exit code: 0 when something matched, 1 when nothing did (as `grep` does).
 */
export async function searchTests(config: Config): Promise<number> {
  // A bare --search/--print has no expression of its own, so it previews whatever -t/-m set; with
  // neither, an undefined filter matches everything and the command lists the whole suite.
  const filter = typeof config.search === 'string' ? config.search : config.filter;
  const files = Object.keys(config.fsTree);
  const scanned = await Promise.all(files.map((file) => scanFile(file, config.projectRoot)));

  const found = scanned.flatMap((record) => record.tests);
  const computed = scanned.reduce((sum, record) => sum + record.computed, 0);
  const unparseable = scanned.filter((record) => record.scan === null).length;

  // Resolve each file's `#34` line targets from the scan already in hand — mirroring a real run's
  // per-file scoping, without reading or transforming any file a second time.
  const lineSelectors: FileSelectors = new Map();
  const warnings: string[] = [];
  for (const record of scanned) {
    const lines = config.lineTargets?.[record.file];
    if (lines && record.scan) {
      const resolved = selectorsFromScan(record.scan, lines, record.displayPath);
      lineSelectors.set(record.file, resolved);
      warnings.push(...resolved.warnings);
    }
  }

  const matches = found.filter(
    (test) => matchesQUnitFilter(filter, test.fullName) && matchesLineTargets(test, lineSelectors),
  );
  const width = Math.max(0, ...matches.map((test) => test.fullName.length));
  for (const test of matches) {
    process.stdout.write(`${test.fullName.padEnd(width)}  ${blue(test.location)}\n`);
  }

  process.stdout.write(
    `\n${matches.length} of ${found.length} test${found.length === 1 ? '' : 's'}` +
      `${filter ? ` match ${JSON.stringify(filter)}` : ''}` +
      ` in ${files.length} file${files.length === 1 ? '' : 's'}\n`,
  );
  for (const warning of warnings) {
    process.stdout.write(yellow(`# qunitx: ${warning}\n`));
  }
  if (computed > 0) {
    // Deliberately "declaration", not "test": one `test(`case ${i}`)` inside a loop is a single
    // declaration that becomes N tests at runtime, and the scan cannot know N.
    process.stdout.write(
      yellow(
        `# ${computed} test declaration${computed === 1 ? '' : 's'} named at runtime ` +
          `(e.g. test(\`case \${i}\`)) cannot be listed without running — they may still match.\n`,
      ),
    );
  }
  if (unparseable > 0) {
    process.stdout.write(
      yellow(`# ${unparseable} file${unparseable === 1 ? '' : 's'} could not be parsed.\n`),
    );
  }

  return matches.length > 0 ? 0 : 1;
}

export { searchTests as default };

/** Per-file resolved line targets. `selectors: null` means "run the whole file" (no restriction). */
type FileSelectors = Map<string, { selectors: QUnitSelector[] | null; warnings: string[] }>;

/**
 * True when a test survives its file's line targets. A file with no targets, or one whose targets
 * degraded to "run the whole file" (`selectors: null`), imposes no restriction. Otherwise the test
 * must match a selector — the same membership the browser applies via `QUnit.config.testFilter`.
 */
function matchesLineTargets(test: FoundTest, lineSelectors: FileSelectors): boolean {
  const resolved = lineSelectors.get(test.file);
  if (!resolved || resolved.selectors === null) return true;

  return resolved.selectors.some((selector) =>
    selector.test === undefined
      ? test.module === selector.module || test.module.startsWith(`${selector.module} > `)
      : test.module === selector.module && test.testName === selector.test,
  );
}

/**
 * Scans one file once: its parsed declarations (kept so line targets can reuse them) and the
 * listable tests derived from them. `scan` is null when the file cannot be read or parsed.
 */
async function scanFile(file: string, projectRoot: string): Promise<ScannedFile> {
  const displayPath = path.relative(projectRoot, file).replaceAll('\\', '/');
  const source = await fs.readFile(file, 'utf8').catch(() => null);
  const scan = source === null ? null : await parseTestDeclarations(source, file);
  if (!scan) return { file, displayPath, scan: null, tests: [], computed: 0 };

  // One pass over the declarations: collect the listable tests and count the computed (null-named)
  // ones. A single fold — no throwaway filter arrays, and `name` narrows to string after the guard,
  // so no non-null assertions.
  const { tests, computed } = scan.declarations.reduce(
    (acc, declaration) => {
      if (declaration.kind !== 'test') return acc;
      if (declaration.name === null) {
        acc.computed++;
        return acc;
      }
      const module =
        declaration.parent === null ? '' : modulePathOf(scan.declarations, declaration.parent);
      acc.tests.push({
        file,
        module,
        testName: declaration.name,
        fullName: qunitFullName(module, declaration.name),
        location: `${displayPath}#${declaration.startLine}`,
      });

      return acc;
    },
    { tests: [] as FoundTest[], computed: 0 },
  );

  return { file, displayPath, scan, tests, computed };
}

/** Walks up `parent` links to build QUnit's ' > '-joined module name. */
function modulePathOf(declarations: TestDeclaration[], index: number): string {
  const names: string[] = [];
  let current: number | null = index;
  while (current !== null) {
    const declaration: TestDeclaration = declarations[current];
    names.unshift(declaration.name ?? '');
    current = declaration.parent;
  }

  return names.join(' > ');
}
