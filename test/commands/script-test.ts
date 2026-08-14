import fs from 'node:fs/promises';
import path from 'node:path';
import { module, test } from 'qunitx';
import { execute, shellFails, shellWatch } from '../helpers/shell.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

const CLI = `node cli.ts`;
const CWD = process.cwd();
const SCRIPTS = `${CWD}/test/fixtures/scripts`;

module('Commands | qunitx run <script>', { concurrency: true }, () => {
  test('runs the file in the browser and prints only what the script printed', async (assert) => {
    const result = await execute(`${CLI} run ${SCRIPTS}/browser-script.ts`);

    assert.includes(result.stdout, 'label: top-level await');
    assert.includes(result.stdout, 'dom: rendered');
    assert.includes(result.stdout, 'origin: true');
    assert.includes(result.stdout, 'meta: string');
    // The whole point of the mode: none of the test runner's scaffolding.
    assert.notIncludes(result.stdout, 'TAP version');
    assert.notIncludes(result.stdout, '0 tests registered');
    assert.notIncludes(result.stdout, '1..0');
    assert.strictEqual(result.code, 0);
  });

  test('a throwing script exits 1 with a source-mapped stack and no qunitx frames', async (assert) => {
    const result = await shellFails(`${CLI} run ${SCRIPTS}/throwing-script.ts`);

    assert.strictEqual(result.code, 1);
    assert.includes(result.stdout, 'before the throw');
    assert.includes(result.stderr, 'Error: script blew up');
    // Mapped back through the inline source map: the ORIGINAL file, not the served bundle.
    assert.includes(result.stderr, 'at detonate (test/fixtures/scripts/throwing-script.ts:5:9)');
    assert.notIncludes(result.stderr, 'script.js');
    assert.notIncludes(result.stderr, '<stdin>');
  });

  test('globalThis.exitCode becomes the process exit code', async (assert) => {
    const result = await shellFails(`${CLI} run ${SCRIPTS}/exit-code-script.ts`);

    assert.strictEqual(result.code, 3);
    assert.includes(result.stdout, 'setting an exit code');
  });

  test('console levels split across stdout and stderr, in emit order', async (assert) => {
    const result = await execute(`${CLI} run ${SCRIPTS}/streams-script.ts`);

    assert.includes(result.stderr, 'a warning');
    assert.includes(result.stderr, 'an error');
    assert.notIncludes(result.stdout, 'a warning');
    // The slow-to-serialize object is emitted FIRST, so every one of the cheap lines behind it
    // must print after it. Unordered writes let them overtake its bigger CDP round-trip.
    const lines = result.stdout.split('\n');
    const objectAt = lines.findIndex((line) => line.includes('rows:'));
    const firstLineAt = lines.findIndex((line) => line === 'line 0');
    assert.ok(
      objectAt !== -1 && firstLineAt > objectAt,
      `object at ${objectAt}, line 0 at ${firstLineAt}`,
    );
    assert.deepEqual(
      lines.filter((line) => line.startsWith('line ')),
      Array.from({ length: 12 }, (_, index) => `line ${index}`),
    );
  });

  test('a browser-only script is NOT run as a test file by the bare form', async (assert) => {
    // The other half of the design: `qunitx <file>` still means "run its tests", and a file with
    // none is a warning that points at the script mode rather than silently becoming one.
    const result = await execute(`${CLI} ${SCRIPTS}/exit-code-script.ts`);

    assert.includes(result.stdout, '# Warning: 0 tests registered');
    assert.includes(result.stdout, 'qunitx run test/fixtures/scripts/exit-code-script.ts');
    assert.strictEqual(result.code, 0);
  });

  test('--watch re-runs the script when it changes', async (assert) => {
    await using directory = await tempDir('script-watch');
    const script = path.join(directory.path, 'watched.ts');
    await fs.writeFile(script, `console.log('VERSION ONE');\n`);

    // The edit is driven from `until` because that is the only callback shellWatch gives that
    // sees output as it arrives: it fires once the first run has printed, then waits for the
    // second. Two phases, one predicate. Deliberately triggered on the script's OWN output
    // rather than the "Watching" banner, so the save lands while the first run is still in
    // flight — the case that wedged two runs against one page on a slow runner.
    let edited = false;
    // shellWatch reports a timeout as a bare "timed out after 210000ms" with no trace of what
    // the child said, which is unactionable on a lane that cannot be reproduced locally.
    let seen = '';
    const output = await shellWatch(`${CLI} run ${script} --watch`, {
      onSpawn: (child) => {
        child.stdout.on('data', (chunk: Buffer) => (seen += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (seen += chunk.toString()));
      },
      until: (buffer) => {
        if (!edited && buffer.includes('VERSION ONE')) {
          edited = true;
          void fs.writeFile(script, `console.log('VERSION TWO');\n`);
        }
        return buffer.includes('VERSION TWO');
      },
    }).catch((error: Error) => {
      throw new Error(`${error.message}\nchild output so far:\n${seen || '(nothing)'}`);
    });

    assert.includes(output, 'VERSION ONE');
    assert.includes(output, 'VERSION TWO');
  });

  test('rejects anything other than exactly one script file', async (assert) => {
    const none = await shellFails(`${CLI} run`);
    assert.includes(none.stderr, 'qunitx run needs exactly one script file (got 0)');

    const two = await shellFails(
      `${CLI} run ${SCRIPTS}/browser-script.ts ${SCRIPTS}/exit-code-script.ts`,
    );
    assert.includes(two.stderr, 'qunitx run needs exactly one script file (got 2)');
  });

  test('a missing script names the file rather than the bundler', async (assert) => {
    const result = await shellFails(`${CLI} run ${SCRIPTS}/does-not-exist.ts`);

    assert.strictEqual(result.code, 1);
    assert.includes(result.stderr, 'no such script');
    assert.includes(result.stderr, 'does-not-exist.ts');
    // The message esbuild's lenient handling of an unresolvable dynamic import used to produce.
    assert.notIncludes(result.stderr, 'dynamically imported module');
  });

  test('a script with a syntax error fails the build and never opens a page', async (assert) => {
    // Written here rather than committed as a fixture: an unparseable file under test/ would fail
    // `prettier --check` for every future contributor, which is a steep price for one assertion.
    await using directory = await tempDir('script-syntax');
    const script = path.join(directory.path, 'broken.ts');
    await fs.writeFile(script, 'const missingParen = (\n');

    const result = await shellFails(`${CLI} run ${script}`);

    assert.strictEqual(result.code, 1);
    assert.includes(result.stderr, 'could not build');
    assert.notIncludes(result.stdout, 'TAP version');
  });
});
