import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

// Turns the junit XML a failed run already wrote into GitHub Actions annotations.
//
// Written because a red CI job was undiagnosable from outside: job logs need admin rights (403),
// artifacts need a token (401), the Actions UI is JavaScript, and dorny's annotations said only
// "Failed test were found" — or "No file matches path ./junit-artifacts/junit-windows-latest/
// *.xml", which is itself the reporting pipeline failing quietly. Annotations, by contrast, are
// readable by anyone who can read the repository.
//
// So the names of the failing tests end up somewhere a person — or a script — can reach without
// being the repository's owner. It reads what the runner already produces and changes nothing
// about how tests run.

/** One failing testcase, as junit records it. */
export interface Failure {
  /** The file the suite came from, which is also what `classname` carries here. */
  file: string;
  /** The test's own name. */
  name: string;
  /** The first line of the assertion message, or `''` where junit recorded none. */
  message: string;
}

/**
 * Every failing testcase in one junit document.
 *
 * Read with a regex rather than an XML parser: this repository has three production dependencies
 * and none of them parse XML, and the shape here is one this project generates itself.
 *
 * ```ts
 * import { failuresFrom } from './annotate-failures.ts';
 *
 * const xml = `<testsuites><testsuite name="a-test.ts">
 *   <testcase name="adds" classname="a-test.ts"/>
 *   <testcase name="breaks" classname="a-test.ts"><failure message="nope"/></testcase>
 * </testsuite></testsuites>`;
 * failuresFrom(xml); // [{ file: 'a-test.ts', name: 'breaks', message: 'nope' }]
 * ```
 */
export function failuresFrom(xml: string): Failure[] {
  const found: Failure[] = [];
  const cases = xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g);

  for (const one of cases) {
    const attributes = one[1] ?? '';
    const body = one[3] ?? '';
    if (!body.includes('<failure') && !body.includes('<error')) continue;

    found.push({
      file: unescaped(attributeOf(attributes, 'classname') ?? ''),
      name: unescaped(attributeOf(attributes, 'name') ?? '<unnamed>'),
      message: firstLine(messageIn(body)),
    });
  }

  return found;
}

/**
 * One failure as a workflow command.
 *
 * `%0A`, `%0D` and `%25` because a raw newline would end the command and leave the rest of the
 * message as ordinary log output — the escaping is Actions' own, not a preference.
 *
 * ```ts
 * import { asAnnotation } from './annotate-failures.ts';
 *
 * asAnnotation({ file: 'a-test.ts', name: 'breaks', message: 'nope' });
 * // '::error file=a-test.ts,title=a-test.ts::breaks — nope'
 * ```
 */
export function asAnnotation(failure: Failure): string {
  const said = failure.message === '' ? failure.name : `${failure.name} — ${failure.message}`;
  const encoded = said.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  const where = failure.file === '' ? '' : `file=${failure.file},title=${failure.file}`;

  return `::error ${where}::${encoded}`;
}

/** The value of one attribute, or `null` where it is absent. */
function attributeOf(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes);

  return match ? (match[1] as string) : null;
}

/** A `<failure>`'s message attribute, falling back to its text content. */
function messageIn(body: string): string {
  const attribute = /<(?:failure|error)\b[^>]*\bmessage="([^"]*)"/.exec(body);
  if (attribute) return unescaped(attribute[1] as string);

  const text = /<(?:failure|error)\b[^>]*>([\s\S]*?)<\/(?:failure|error)>/.exec(body);

  return text ? unescaped(text[1] as string).trim() : '';
}

/** The five entities junit writes. Enough, because this project writes the XML it reads here. */
function unescaped(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#10;', '\n')
    .replaceAll('&amp;', '&');
}

/** Assertion messages run to dozens of lines; an annotation wants the sentence. */
function firstLine(message: string): string {
  return (message.split('\n')[0] ?? '').trim().slice(0, 300);
}

// `node scripts/annotate-failures.ts [dir]` — reads every junit-*.xml under `dir` (default `tmp`)
// and prints one annotation per failing test. Always exits 0: the job has already failed for its
// own reason, and this must not become a second, competing one.
if (process.argv[1]?.endsWith('annotate-failures.ts')) {
  const directory = process.argv[2] ?? 'tmp';
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  const documents = names.filter((name) => name.startsWith('junit-') && name.endsWith('.xml'));

  if (documents.length === 0) {
    process.stdout.write(
      `::warning::no junit-*.xml under ${directory} — the run failed before writing any\n`,
    );
  } else {
    const flat: Failure[] = [];
    for (const name of documents) {
      flat.push(...failuresFrom(await fs.readFile(path.join(directory, name), 'utf8')));
    }
    for (const failure of flat) process.stdout.write(`${asAnnotation(failure)}\n`);
    process.stdout.write(
      flat.length === 0
        ? `::warning::${documents.length} junit file(s) under ${directory}, none recording a failure\n`
        : `\n${flat.length} failing test(s) across ${documents.length} junit file(s)\n`,
    );
  }
}
