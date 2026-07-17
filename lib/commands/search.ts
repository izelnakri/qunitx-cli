import fs from 'node:fs/promises';
import path from 'node:path';
import { parseTestDeclarations } from '../utils/parse-test-declarations.ts';
import { matchesQUnitFilter, qunitFullName } from '../utils/qunit-filter-match.ts';
import { blue, yellow } from '../utils/color.ts';
import type { TestDeclaration } from '../utils/parse-test-declarations.ts';
import type { Config } from '../types.ts';

/** One test found by the static scan, named exactly as QUnit would name it. */
interface FoundTest {
  /** `"Module > Sub: test name"` — the string a filter matches against. */
  fullName: string;
  /** Where it is declared, `path#line`, ready to paste back as a line target. */
  location: string;
}

/**
 * `--search` / `-s` / `--print` / `-p`: list the tests a filter matches, without running them.
 *
 * The listing comes from the same static declaration scanner `file#line` targets use — no browser,
 * no bundle, no test execution — and matching goes through a port of QUnit's own filter that is
 * differential-tested against a real run, so the preview reflects what an actual run would select.
 *
 * The trade-off of scanning instead of executing: a test whose name is computed
 * (``test(`case ${i}`)``) has no name until the browser runs it, so it cannot be listed. Those are
 * counted and reported rather than silently omitted.
 *
 * @returns the process exit code: 0 when something matched, 1 when nothing did (as `grep` does).
 */
export async function searchTests(config: Config): Promise<number> {
  // A bare --search/-p has no expression of its own, so it previews whatever -t/-m set; with
  // neither, an undefined filter matches everything and the command lists the whole suite.
  const filter = typeof config.search === 'string' ? config.search : config.filter;
  const files = Object.keys(config.fsTree);
  const scans = await Promise.all(files.map((file) => scanFile(file, config.projectRoot)));

  const found: FoundTest[] = [];
  let computed = 0;
  let unparseable = 0;
  for (const scan of scans) {
    if (scan === null) {
      unparseable++;
      continue;
    }
    found.push(...scan.tests);
    computed += scan.computed;
  }

  const matches = found.filter((test) => matchesQUnitFilter(filter, test.fullName));
  const width = Math.max(0, ...matches.map((test) => test.fullName.length));
  for (const test of matches) {
    process.stdout.write(`${test.fullName.padEnd(width)}  ${blue(test.location)}\n`);
  }

  process.stdout.write(
    `\n${matches.length} of ${found.length} test${found.length === 1 ? '' : 's'}` +
      `${filter ? ` match ${JSON.stringify(filter)}` : ''}` +
      ` in ${files.length} file${files.length === 1 ? '' : 's'}\n`,
  );
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

/** Scans one file into QUnit-named tests, or null when it cannot be parsed. */
async function scanFile(
  file: string,
  projectRoot: string,
): Promise<{ tests: FoundTest[]; computed: number } | null> {
  const source = await fs.readFile(file, 'utf8').catch(() => null);
  if (source === null) return null;

  const scan = await parseTestDeclarations(source, file);
  if (!scan) return null;

  const displayPath = path.relative(projectRoot, file).replaceAll('\\', '/');
  const tests: FoundTest[] = [];
  let computed = 0;
  scan.declarations.forEach((declaration) => {
    if (declaration.kind !== 'test') return;
    if (declaration.name === null) {
      computed++;
      return;
    }
    const modulePath =
      declaration.parent === null ? '' : modulePathOf(scan.declarations, declaration.parent);
    tests.push({
      fullName: qunitFullName(modulePath, declaration.name),
      location: `${displayPath}#${declaration.startLine}`,
    });
  });

  return { tests, computed };
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
