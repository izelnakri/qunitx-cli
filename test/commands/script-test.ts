import fs from 'node:fs/promises';
import path from 'node:path';
import { module, test } from 'qunitx';
import { execute, shellFails, shellWatch } from '../helpers/shell.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

const CLI = `node cli.ts`;
const CWD = process.cwd();
const SCRIPTS = `${CWD}/test/fixtures/scripts`;

// `run` is the script verb, but a file that REGISTERS QUnit tests is a suite whichever verb points
// at it. Running it as a plain script would evaluate it, register three tests, run none of them and
// exit 0 in silence — success reported for tests that never ran, which is the one outcome a test
// runner must never produce.
module('Commands | qunitx run <test file>', { concurrency: true }, () => {
  const PASSING = `${CWD}/test/fixtures/passing-tests.js`;

  test('runs the tests it declared and reports them as TAP', async (assert) => {
    const result = await execute(`${CLI} run ${PASSING}`);

    assert.includes(result.stdout, 'TAP version 13');
    assert.includes(result.stdout, 'ok 1 {{moduleName}} Passing Tests | assert true works');
    assert.includes(result.stdout, '1..3');
    assert.includes(result.stdout, '# pass 3');
    assert.includes(result.stdout, '# fail 0');
    assert.strictEqual(result.code, 0);
  });

  test('the report matches the one the bare verb produces for the same file', async (assert) => {
    // The promise this verb makes: pointing `run` at a suite is not a lesser way to run it. Both
    // are normalised for the numbers that legitimately differ between two runs — durations.
    // Sequential on purpose: this needs two browsers and nothing about it needs them at once. Run
    // concurrently they doubled this file's peak draw on the shared Chrome semaphore, which every
    // other test file is queueing behind.
    const viaRun = await execute(`${CLI} run ${PASSING}`);
    const viaBare = await execute(`${CLI} ${PASSING}`);
    // Durations and per-test timings legitimately differ between two runs. Blank lines are
    // collapsed too: the bare verb emits one more of them around its summary block than this path
    // does, which no TAP consumer can see — every parser is line-oriented and skips blanks — and
    // which is not worth reproducing by hand. Every line that carries meaning is compared exactly.
    const normalise = (text: string) =>
      text
        .split('\n')
        .filter(
          (line) =>
            line.trim() !== '' &&
            !line.startsWith('# duration') &&
            // The one line `run` adds and the bare verb has no reason to: see the test below.
            !line.includes('ran as a suite'),
        )
        .map((line) =>
          line.replace(/# \(\d+ ms\)/, '# (N ms)').replace(/localhost:\d+/, 'localhost:PORT'),
        )
        .join('\n');

    assert.strictEqual(normalise(viaRun.stdout), normalise(viaBare.stdout));
  });

  test('a failing suite exits 1, exactly as the bare verb does', async (assert) => {
    const viaRun = await shellFails(`${CLI} run ${CWD}/test/fixtures/failing-tests.js`);

    assert.strictEqual(viaRun.code, 1, 'a red suite is a red run, whichever verb ran it');
    assert.includes(viaRun.stdout, 'not ok 2', 'the first test in that fixture passes');
    assert.includes(
      viaRun.stdout,
      'test/fixtures/failing-tests.js:',
      'and the failure resolves to source, not to a frame inside the served bundle',
    );
  });

  test('it says the plain form is the better way to have asked', async (assert) => {
    // Allowed but discouraged: it works and reports identically, so this is a notice rather than a
    // failure — and it names the exact command to use instead, project-relative and pasteable.
    const result = await execute(`${CLI} run ${PASSING}`);

    assert.includes(result.stdout, 'ran as a suite (declares tests)');
    assert.includes(result.stdout, 'globalThis.exitCode is ignored');
    assert.includes(result.stdout, 'Prefer: qunitx test/fixtures/passing-tests.js');
    assert.strictEqual(result.code, 0, 'discouraged, not refused');
    const lines = result.stdout.split('\n');
    assert.strictEqual(lines[0], 'TAP version 13', 'and it never displaces the TAP version line');
    assert.ok(
      lines.find((line) => line.includes('ran as a suite'))!.startsWith('# '),
      'a TAP stream carries it as a comment, not as a stray line',
    );
  });

  test('the tests set the exit code, and globalThis.exitCode does not', async (assert) => {
    // What the warning promises, pinned. A suite's verdict is the whole point of running one, so a
    // file that declares tests cannot talk its way to green — nor accidentally to red.
    await using directory = await tempDir('run-suite-exit-code');
    const declare = (name: string, body: string) =>
      `import { module, test } from 'qunitx';\n${body}\n` +
      `module('${name}', function () {\n` +
      `  test('t', function (assert) { assert.equal(1, ${name === 'Red' ? 2 : 1}); });\n` +
      `});\n`;
    const redSilenced = path.join(directory.path, 'red-silenced.ts');
    const greenLoud = path.join(directory.path, 'green-loud.ts');
    await fs.writeFile(redSilenced, declare('Red', 'globalThis.exitCode = 0;'));
    await fs.writeFile(greenLoud, declare('Green', 'globalThis.exitCode = 7;'));

    const red = await shellFails(`${CLI} run ${redSilenced}`);
    const green = await execute(`${CLI} run ${greenLoud}`);

    assert.strictEqual(red.code, 1, 'a failing test cannot be silenced by globalThis.exitCode = 0');
    assert.strictEqual(
      green.code,
      0,
      'nor can a passing suite be failed by globalThis.exitCode = 7',
    );
  });

  test('tests declared by an IMPORTED module run too', async (assert) => {
    // The reason the count is read from QUnit after evaluation rather than scanned from the source:
    // this entry declares nothing itself, and a scan would call it a script.
    await using directory = await tempDir('run-imported-tests');
    const inner = path.join(directory.path, 'inner-test.ts');
    const entry = path.join(directory.path, 'entry.ts');
    await fs.writeFile(
      inner,
      `import { module, test } from 'qunitx';\n` +
        `module('Imported', function () {\n` +
        `  test('declared elsewhere', function (assert) { assert.ok(true); });\n` +
        `});\n`,
    );
    await fs.writeFile(entry, `import './inner-test.ts';\n`);

    const result = await execute(`${CLI} run ${entry}`);

    assert.includes(result.stdout, 'ok 1 Imported | declared elsewhere');
    assert.includes(result.stdout, '# pass 1');
    assert.strictEqual(result.code, 0);
  });

  test('--reporter reaches the suite the file declared', async (assert) => {
    const result = await execute(`${CLI} run ${PASSING} --reporter=spec`);

    assert.includes(result.stdout, '✔ assert true works');
    assert.includes(result.stdout, '3 passing');
    assert.notIncludes(result.stdout, 'TAP version', 'spec replaces TAP rather than joining it');
  });

  test("a test's own console output stays out of the TAP stream", async (assert) => {
    // passing-tests.js logs from inside a test. Streaming it — which is what the script verb does
    // with a script's output — would interleave raw lines with `ok 1 …`, and the result would not
    // parse as TAP any more.
    const result = await execute(`${CLI} run ${PASSING}`);

    assert.notIncludes(result.stdout, 'calling assert true test case');
  });
});

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
