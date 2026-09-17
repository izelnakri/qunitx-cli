import fs from 'node:fs';
import path from 'node:path';
import { module, test } from 'qunitx';

// The nyan tutorial in docs/javascript-api.md quotes examples/nyan-reporter.ts, and a quote is a
// copy: the two drifted apart once already — the doc taught `styled(31, '!')` for a helper the
// example spells `inColor(RED, '!')`, and nothing failed, because a snippet in a markdown file is
// not compiled by anything. So the snippets are checked against the file they claim to be from.
const ROOT = path.resolve(import.meta.dirname ?? '', '../..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs/javascript-api.md'), 'utf8');
const EXAMPLE = fs.readFileSync(path.join(ROOT, 'examples/nyan-reporter.ts'), 'utf8');

/** The tutorial section only — the rest of the document is about other things. */
function tutorial(): string {
  const from = DOC.indexOf('## Tutorial: a nyan cat reporter');
  const next = DOC.indexOf('\n## ', from + 1);

  return DOC.slice(from, next === -1 ? DOC.length : next);
}

/**
 * The fenced blocks inside it, which are the part that is a copy of something — with their own
 * comments stripped, because prose is not a reference. A comment reading "the colour FUNCTIONS"
 * is not the snippet naming a constant, and this test said it was until it was.
 */
function snippets(section: string): string[] {
  return [...section.matchAll(/```(?:ts|js)\n([\s\S]*?)```/g)].map((found) =>
    (found[1] ?? '').replaceAll(/\/\/.*$/gm, ''),
  );
}

module('Api | the nyan tutorial quotes the file it links to', { concurrency: true }, () => {
  test('every helper the snippets call is defined in the example', (assert) => {
    const code = snippets(tutorial()).join('\n');
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
        new RegExp(`\\b${name}\\b`).test(EXAMPLE),
        `docs call \`${name}(…)\` — examples/nyan-reporter.ts must define or import it`,
      );
    }
  });

  test('every constant the snippets name is defined in the example', (assert) => {
    const code = snippets(tutorial()).join('\n');
    // SCREAMING_CASE, which is how this example spells a colour and a frame table.
    const named = new Set([...code.matchAll(/\b([A-Z][A-Z_]{2,})\b/g)].map((found) => found[1]));
    // Colours are lowercase FUNCTIONS now, so they are caught by the call check above; what is
    // left in this shape is the two tables. `RAINBOW` is the one the tutorial cannot do without.
    assert.true(named.has('RAINBOW'), 'the snippets do name a table, or this test proves nothing');

    for (const name of named) {
      // Declared by the example, or read off the environment by it — `NO_COLOR` is the second
      // kind, and is exactly as much of a promise to the reader as `RED` is.
      const declared = new RegExp(`const ${name}\\b`).test(EXAMPLE);
      const fromEnv = EXAMPLE.includes(`process.env.${name}`);

      assert.true(
        declared || fromEnv,
        `docs name \`${name}\` — examples/nyan-reporter.ts must declare or read it`,
      );
    }
  });

  test('the example runs the public contract, not the reporter internals', (assert) => {
    assert.true(EXAMPLE.includes("from '../lib/api/index.ts'"), 'the public entry point');
    assert.false(EXAMPLE.includes('lib/reporters/'), 'a reader copying this cannot reach in there');
    assert.true(
      EXAMPLE.includes('NO_COLOR'),
      'it honours the one env var a writer of escapes must',
    );
  });
});
