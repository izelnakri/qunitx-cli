import fs from 'node:fs/promises';
import path from 'node:path';
import { parseTestDeclarations } from '../selection/parse-test-declarations.ts';
import { matchQUnitFilter, buildQUnitFullName } from '../selection/qunit-matcher.ts';
import * as LineTargets from '../selection/line-targets.ts';
import { blue, yellow } from '../utils/color.ts';
import type { TestDeclaration, DeclarationScan } from '../selection/parse-test-declarations.ts';
import type { QUnitSelector } from '../selection/line-targets.ts';
import type { Config } from '../types.ts';

/** One scanned file: its parsed declarations (null when unparseable) and the tests derived from them. */
interface ScannedFile {
  /** Absolute path of the file. */
  file: string;
  /** Project-relative path with forward slashes — what the listing prints. */
  displayPath: string;
  /** The parsed declarations, kept so line targets reuse them; null when the file could not be read or parsed. */
  scan: DeclarationScan | null;
  /** The listable tests: every declaration whose name is a literal. */
  tests: FoundTest[];
  /**
   * How many test declarations in this file have a name computed at runtime
   * (``test(`case ${i}`)``). Their names do not exist until the browser runs them, so they cannot
   * be listed — they are counted here and reported, rather than silently omitted.
   */
  computedNames: number;
}

/**
 * One test found by the static scan, named exactly as QUnit would name it.
 *
 * Structured rather than pre-joined: `modules` and `line` are what a caller can act on, and the
 * display forms (`'A > B'`, `path#12`) are one join away wherever they are actually printed.
 */
export interface FoundTest {
  /** `"Module > Sub: test name"` — the string a filter matches against. */
  fullName: string;
  /** The test's own name. */
  name: string;
  /** The QUnit module path it is declared under; empty for a top-level test. */
  modules: string[];
  /** Absolute path of the file it was declared in — used to apply that file's line targets. */
  file: string;
  /** 1-based line of the declaration. */
  line: number;
}

/**
 * `--search` / `-s` / `--print` / `--preview`: list the tests the current selection matches,
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
 * ```ts
 * import type { Config } from '../types.ts';
 * // Defined, not invoked: reads and scans every selected file, prints the listing.
 * async function searchCommand(config: Config) {
 *   return await run(config); // 'Cart: checkout  test/cart-test.ts#12' … then the match count
 * }
 * ```
 *
 * @returns the process exit code: 0 when something matched, 1 when nothing did (as `grep` does).
 */
export async function run(config: Config): Promise<number> {
  const report = await scan(config);
  // Folded rather than `Math.max(0, ...matches.map(…))`: the spread passes one argument per match,
  // which throws RangeError once a suite is large enough, and the map allocates an array to throw
  // away. One write rather than one per line — a big listing is thousands of syscalls otherwise.
  const width = report.matches.reduce((widest, test) => Math.max(widest, test.fullName.length), 0);
  config.state.console.log(
    report.matches
      .map((test) => `${test.fullName.padEnd(width)}  ${blue(locationOf(config, test))}\n`)
      .join(''),
  );

  config.state.console.log(
    `\n${report.matches.length} of ${report.total} test${report.total === 1 ? '' : 's'}` +
      `${report.filter ? ` match ${JSON.stringify(report.filter)}` : ''}` +
      ` in ${report.files} file${report.files === 1 ? '' : 's'}\n`,
  );
  for (const warning of report.warnings) {
    config.state.console.log(yellow(`# qunitx: ${warning}\n`));
  }
  if (report.unlistable.computedNames > 0) {
    // Deliberately "declaration", not "test": one `test(`case ${i}`)` inside a loop is a single
    // declaration that becomes N tests at runtime, and the scan cannot know N.
    config.state.console.log(
      yellow(
        `# ${report.unlistable.computedNames} test declaration${report.unlistable.computedNames === 1 ? '' : 's'} named at runtime ` +
          `(e.g. test(\`case \${i}\`)) cannot be listed without running — they may still match.\n`,
      ),
    );
  }
  if (report.unlistable.unparseable > 0) {
    config.state.console.log(
      yellow(
        `# ${report.unlistable.unparseable} file${report.unlistable.unparseable === 1 ? '' : 's'} could not be parsed.\n`,
      ),
    );
  }
  if (report.unlistable.silent > 0) {
    config.state.console.log(
      yellow(
        `# ${report.unlistable.silent} file${report.unlistable.silent === 1 ? '' : 's'} declared no tests the scan could see — a ` +
          `declarator reached through a local alias (const t = QUnit.test) is invisible to it.\n`,
      ),
    );
  }

  return report.matches.length > 0 ? 0 : 1;
}

/**
 * What the static scan found, before anything is printed.
 *
 * Separated from {@link run} so the same answer can be a value: `run` is this plus a listing,
 * and the JS API's `search()` is this plus nothing.
 *
 * ```ts
 * const report: SearchReport = {
 *   matches: [], total: 12, files: 3, filter: 'Cart', warnings: [],
 *   unlistable: { total: 0, computedNames: 0, unparseable: 0, silent: 0 },
 * };
 * report.matches.length; // 0 of 12 — the filter matched nothing
 * ```
 */
export interface SearchReport {
  /** The tests the current selection matches, in declaration order. */
  matches: FoundTest[];
  /** Every listable test found, matched or not. */
  total: number;
  /** How many files were scanned. */
  files: number;
  /** The expression matched against, or `undefined` when everything was listed. */
  filter?: string;
  /** Line-target resolution warnings, in input order. */
  warnings: string[];
  /** What the scan could not name, split by cause. */
  unlistable: UnlistableCounts;
}

/**
 * Why some declarations could not be listed, split by cause.
 *
 * Broken out rather than summed, because the three are not the same news: computed names are
 * normal in a parameterised suite, whereas an unparseable file is usually a real problem.
 *
 * ```ts
 * const counts: UnlistableCounts = { total: 3, computedNames: 2, unparseable: 0, silent: 1 };
 * counts.total === counts.computedNames + counts.unparseable + counts.silent; // true
 * ```
 */
export interface UnlistableCounts {
  /** The three below, added up. */
  total: number;
  /** Declarations whose name is computed at run time — ``test(`case ${index}`)``. */
  computedNames: number;
  /** Files that could not be read or parsed at all. */
  unparseable: number;
  /** Files that parsed but declared no test the scan could see, e.g. via a local alias. */
  silent: number;
}

/**
 * Scans the selected files and resolves which of their tests the current selection matches —
 * no browser, no bundle, no execution.
 *
 * ```ts
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: reads and parses every selected file.
 * async function preview(config: Config) {
 *   const report = await scan(config);
 *   return `${report.matches.length} of ${report.total}`;
 * }
 * ```
 */
export async function scan(config: Config): Promise<SearchReport> {
  // A bare --search/--print has no expression of its own, so it previews whatever -t/-m set; with
  // neither, an undefined filter matches everything and the command lists the whole suite.
  const filter = typeof config.search === 'string' ? config.search : config.filter;
  const files = Object.keys(config.fsTree);
  const scanned = await Promise.all(files.map((file) => scanFile(file, config.projectRoot)));

  // One pass over the scans, because every one of these is a per-file fact: the listable tests,
  // the runtime-named declarations, the two disjoint ways a file contributes nothing, and each
  // file's `#34` line targets resolved from the scan already in hand — no file is read or
  // transformed a second time.
  //
  // `silent` is usually a file with no tests, but it is also how a declarator reached through a
  // local alias (`const t = QUnit.test`) looks: the scan resolves declarators from the qunitx
  // import and the QUnit global only, so it cannot follow one. Counting it keeps the total honest
  // instead of quietly under-reporting.
  const found: FoundTest[] = [];
  const lineSelectors: FileSelectors = new Map();
  const warnings: string[] = [];
  let computedNames = 0;
  let unparseable = 0;
  let silent = 0;

  for (const record of scanned) {
    // Pushed one at a time rather than spread: `push(...tests)` passes one argument per test and
    // throws RangeError once a suite is large enough.
    for (const test of record.tests) found.push(test);
    computedNames += record.computedNames;

    if (record.scan === null) unparseable++;
    else if (record.tests.length === 0 && record.computedNames === 0) silent++;

    const lines = config.lineTargets?.[record.file];
    if (lines && record.scan) {
      const resolved = LineTargets.selectorsFromScan(record.scan, lines, record.displayPath);
      lineSelectors.set(record.file, resolved);
      warnings.push(...resolved.warnings);
    }
  }

  return {
    matches: found.filter(
      (test) => matchQUnitFilter(filter, test.fullName) && matchesLineTargets(test, lineSelectors),
    ),
    total: found.length,
    files: files.length,
    filter,
    warnings,
    unlistable: { total: computedNames + unparseable + silent, computedNames, unparseable, silent },
  };
}

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

  // Joined here rather than stored joined: the selectors are ' > '-paths, and matching a module
  // and its descendants is a string-prefix question. Same comparison as before, one line later.
  const modulePath = test.modules.join(' > ');

  return resolved.selectors.some((selector) =>
    selector.test === undefined
      ? modulePath === selector.module || modulePath.startsWith(`${selector.module} > `)
      : modulePath === selector.module && test.name === selector.test,
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
  if (!scan) return { file, displayPath, scan: null, tests: [], computedNames: 0 };

  // One pass over the declarations: collect the listable tests and count the computed (null-named)
  // ones. A single fold — no throwaway filter arrays, and `name` narrows to string after the guard,
  // so no non-null assertions.
  const { tests, computedNames } = scan.declarations.reduce(
    (acc, declaration) => {
      if (declaration.kind !== 'test') return acc;
      if (declaration.name === null) {
        acc.computedNames++;
        return acc;
      }
      const modules =
        declaration.parent === null ? [] : modulePathOf(scan.declarations, declaration.parent);
      acc.tests.push({
        fullName: buildQUnitFullName(modules.join(' > '), declaration.name),
        name: declaration.name,
        modules,
        file,
        line: declaration.startLine,
      });

      return acc;
    },
    { tests: [] as FoundTest[], computedNames: 0 },
  );

  return { file, displayPath, scan, tests, computedNames };
}

/** Walks up `parent` links to the module path a test is declared under, outermost first. */
function modulePathOf(declarations: TestDeclaration[], index: number): string[] {
  // Recursing to the outermost module first yields the names already in order, so there is no
  // reversing to reason about. Depth is module nesting (a handful), not input size.
  const ancestry = (at: number | null): string[] =>
    at === null ? [] : [...ancestry(declarations[at].parent), declarations[at].name ?? ''];

  return ancestry(index);
}

/** The `path#line` a listing prints, relative to the project root. */
function locationOf(config: Config, test: FoundTest): string {
  return `${path.relative(config.projectRoot, test.file).replaceAll('\\', '/')}#${test.line}`;
}
