import fs from 'node:fs/promises';
import path from 'node:path';
import { module, test } from 'qunitx';

// The nyan tutorial in docs/javascript-api.md quotes examples/nyan-reporter.ts, and a quote is a
// copy: the two drifted apart once already — the doc taught `styled(31, '!')` for a helper the
// example spells `inColor(RED, '!')`, and nothing failed, because a snippet in a markdown file is
// not compiled by anything. So the snippets are checked against the file they claim to be from.
//
// Read asynchronously, unlike the path commands in lib/: the suite runs sixteen files at once, so
// a read here genuinely has something to overlap with. A prompt looking up one path has nothing,
// which is why that one is sync and this one is not.
const ROOT = path.resolve(import.meta.dirname ?? '', '../..');
/** The two files this test exists to keep in step. */
const TUTORIAL = 'docs/javascript-api.md';
const EXAMPLE = 'examples/nyan-reporter.ts';

module('Api | the nyan tutorial quotes the file it links to', { concurrency: true }, () => {
  test('a snippet is found whatever the checkout did to its line endings', (assert) => {
    // Pinned on every platform, not just the one that breaks: the Windows-only version of this
    // bug took a push and a red matrix job to see, and a regex is one careless edit from it.
    const crlf = '```ts\r\nconst red = inColor(31);\r\n```\r\n';

    assert.true(snippets(crlf).join('').includes('inColor'), 'CRLF parses the same as LF');
    assert.true(
      snippets('```ts\nconst red = inColor(31);\n```\n').length === 1,
      'and LF still does',
    );
  });

  test('every helper the snippets call is defined in the example', async (assert) => {
    const [doc, example] = await Promise.all([read(TUTORIAL), read(EXAMPLE)]);
    const code = snippets(tutorial(doc)).join('\n');
    // Called like a function and spelled like one of ours — so `RAINBOW.map` and `Math.max` are
    // out (a dot before the name), and so are the hook names the snippets are DEFINING.
    const defining = new Set(['onTestEnd', 'onRunEnd', 'segment', 'test']);
    const called = new Set(
      [...code.matchAll(/(?<![.\w])([a-z][A-Za-z0-9]*)\s*\(/g)]
        .map((found) => found[1] as string)
        .filter((name) => !defining.has(name)),
    );
    assert.true(called.size > 0, 'the snippets do call something, or this test proves nothing');

    for (const name of called) {
      assert.true(
        new RegExp(`\\b${name}\\b`).test(example),
        `docs call \`${name}(…)\` — examples/nyan-reporter.ts must define or import it`,
      );
    }
  });

  test('every constant the snippets name is defined in the example', async (assert) => {
    const [doc, example] = await Promise.all([read(TUTORIAL), read(EXAMPLE)]);
    const code = snippets(tutorial(doc)).join('\n');
    // SCREAMING_CASE, which is how this example spells a colour and a frame table.
    const named = new Set([...code.matchAll(/\b([A-Z][A-Z_]{2,})\b/g)].map((found) => found[1]));
    // Colours are lowercase FUNCTIONS now, so they are caught by the call check above; what is
    // left in this shape is the two tables. `RAINBOW` is the one the tutorial cannot do without.
    assert.true(named.has('RAINBOW'), 'the snippets do name a table, or this test proves nothing');

    for (const name of named) {
      // Declared by the example, or read off the environment by it — `NO_COLOR` is the second
      // kind, and is exactly as much of a promise to the reader as `RED` is.
      const declared = new RegExp(`const ${name}\\b`).test(example);
      const fromEnv = example.includes(`process.env.${name}`);

      assert.true(
        declared || fromEnv,
        `docs name \`${name}\` — examples/nyan-reporter.ts must declare or read it`,
      );
    }
  });

  test('the example runs the public contract, not the reporter internals', async (assert) => {
    const example = await read(EXAMPLE);

    assert.true(example.includes("from '../lib/api/index.ts'"), 'the public entry point');
    assert.false(example.includes('lib/reporters/'), 'a reader copying this cannot reach in there');
    assert.true(
      example.includes('NO_COLOR'),
      'it honours the one env var a writer of escapes must',
    );
  });
});

/**
 * A committed file, with its line endings normalised to `\n`.
 *
 * Windows checks out CRLF — `core.autocrlf` is on by default in Git for Windows, and the hosted
 * runners keep it — so a fenced block opens with ```` ```ts\r\n ````  there and a pattern looking
 * for ```` ```ts\n ```` finds nothing. This test then passed by finding no snippets at all, which
 * is the failure its own "proves nothing" guards exist to catch, and which cost two red Windows
 * jobs to discover. Anything reading a committed text file has this to worry about; reading it
 * through here is how not to.
 */
async function read(relative: string): Promise<string> {
  const contents = await fs.readFile(path.join(ROOT, relative), 'utf8');

  return contents.replaceAll('\r\n', '\n');
}

/** The tutorial section only — the rest of the document is about other things. */
function tutorial(doc: string): string {
  const from = doc.indexOf('## Tutorial: a nyan cat reporter');
  const next = doc.indexOf('\n## ', from + 1);

  return doc.slice(from, next === -1 ? doc.length : next);
}

/**
 * The fenced blocks inside it, which are the part that is a copy of something — with their own
 * comments stripped, because prose is not a reference. A comment reading "the colour FUNCTIONS"
 * is not the snippet naming a constant, and this test said it was until it was.
 */
function snippets(section: string): string[] {
  // `\r?\n` and `\r?$` rather than `\n` and `$`: `read` above already normalises the files this
  // test reads, and this makes the extractor itself not care — which is the half that a future
  // edit can quietly undo, since only Windows would notice.
  return [...section.matchAll(/```(?:ts|js)\r?\n([\s\S]*?)```/g)].map((found) =>
    (found[1] ?? '').replaceAll(/\/\/.*?\r?$/gm, ''),
  );
}
