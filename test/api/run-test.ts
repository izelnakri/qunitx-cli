import fs from 'node:fs/promises';
import path from 'node:path';
import { module, test } from 'qunitx';
import * as QUnitX from '../../lib/api/index.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import { spawnCapture } from '../helpers/shell.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

// `QUnitX.run` runs ONE file as a script — the API twin of `qunitx run <file>`. Namespaced access
// throughout because this file already imports QUnit's own `test`, which the suite verb now
// shares a name with.
const CWD = process.cwd();
// Forward-slashed on purpose, because that is what a caller types on every platform and `run`
// has to accept it. Expectations go through `scriptPath` instead: `result.file` is a filesystem
// path for programmatic use, so it comes back in the host's separators — on Windows all
// backslashes, which a `/`-joined string would never match. (The CLI's copy-pasteable hint is
// the opposite case and is deliberately forward-slashed.)
const SCRIPTS = `${CWD}/test/fixtures/scripts`;
const scriptPath = (name: string) => path.resolve(CWD, 'test/fixtures/scripts', name);
// A cold browser launch per script, on a runner that may be running fifteen other files.
const SCRIPT_TIMEOUT_MS = 120_000;

/**
 * Runs a script with a Chrome permit held, since nothing here goes through the shell helper.
 *
 * Awaited rather than `.result()`-ed: these callers expect a run to happen, so a failure should
 * throw with its own message instead of arriving as a union every test has to re-narrow. The tests
 * that expect a FAILURE call `QUnitX.run(...).result()` directly, which is what that spelling is
 * for — both halves of the contract get exercised, each where it belongs.
 */
async function run(file: string, options: QUnitX.ScriptOptions = {}): Promise<QUnitX.ScriptResult> {
  const permit = await acquireBrowser();
  try {
    return await QUnitX.run(file, options);
  } finally {
    permit.release();
  }
}

module('API | run | script execution', { concurrency: true }, () => {
  test('a script that finishes cleanly resolves ok with its file and a duration', async (assert) => {
    const result = await run(`${SCRIPTS}/browser-script.ts`);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.file, scriptPath('browser-script.ts'));
    assert.ok(result.durationMs >= 0, `durationMs should be a number, got ${result.durationMs}`);
  });

  test('a non-zero exit code is a result, not a rejection', async (assert) => {
    // The same contract the suite verb has for a red run: the runner answered the question, so
    // this resolves rather than throwing — which is the whole point of awaiting it here.
    const result = await run(`${SCRIPTS}/exit-code-script.ts`);

    assert.strictEqual(result.exitCode, 3, 'globalThis.exitCode propagates');
    assert.strictEqual(result.ok, false);
  });

  test('a script that throws comes back as exit code 1', async (assert) => {
    const result = await run(`${SCRIPTS}/throwing-script.ts`);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.exitCode, 1);
  });

  test('a relative path resolves against cwd', async (assert) => {
    const result = await run('test/fixtures/scripts/exit-code-script.ts', { cwd: CWD });

    assert.strictEqual(
      result.file,
      scriptPath('exit-code-script.ts'),
      'a relative argument comes back absolute, in the host separators',
    );
  });
});

module('API | run | what the script printed', { concurrency: true }, () => {
  test('the console option takes the output, with errors kept apart from logs', async (assert) => {
    const logged: string[] = [];
    const errored: string[] = [];
    const result = await run(`${SCRIPTS}/streams-script.ts`, {
      console: { log: (line) => logged.push(line), error: (line) => errored.push(line) },
    });

    assert.strictEqual(result.ok, true, 'writing to stderr is output, not failure');
    assert.includes(logged.join('\n'), 'line 0', 'console.log reaches the log sink');
    assert.includes(errored.join('\n'), 'an error', 'console.error reaches the error sink');
    assert.includes(errored.join('\n'), 'a warning', 'and so does console.warn, as on the CLI');
  });

  test('browserLogs carries the same lines even when the console discards them', async (assert) => {
    // The point of the pair: `console` chooses where output goes, `browserLogs` is what it was.
    // A silent console must capture rather than lose it, or "run it quietly and inspect after"
    // would be impossible.
    const result = await run(`${SCRIPTS}/streams-script.ts`, {
      console: QUnitX.silentConsole,
    });

    const texts = result.browserLogs.map((log) => log.text);
    assert.includes(texts.join('\n'), 'line 0', 'the log survived a silent console');
    assert.strictEqual(result.browserLogsDropped, 0, 'nothing dropped for a small script');
    assert.deepEqual(
      result.browserLogs.filter((log) => log.text.includes('a warning')).map((log) => log.type),
      ['warning'],
      'the page level is kept, so warn stays distinguishable from error',
    );
  });
});

module('API | run | the value the script exported', { concurrency: true }, () => {
  test('a default export comes back as result.value', async (assert) => {
    const result = await run(`${SCRIPTS}/value-script.ts`);

    assert.strictEqual(result.ok, true);
    assert.deepEqual(
      result.value,
      { seeded: 2, ids: [1, 2], note: null },
      'the whole export crosses, nested arrays and nulls included',
    );
  });

  test('a script with no default export has no value', async (assert) => {
    // `no-value-script.ts` has no import or export at all, which makes esbuild compile it as
    // CommonJS — its namespace `default` is a synthesized `{}` that is indistinguishable from a
    // real `export default {}` once it reaches the page. Getting `undefined` here is what proves
    // the two are told apart at build time rather than guessed at afterwards.
    const result = await run(`${SCRIPTS}/no-value-script.ts`);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value, undefined, 'not the empty object CommonJS interop invents');
  });

  test('a value JSON cannot carry fails the run instead of arriving changed', async (assert) => {
    // A Map is the case a JSON round-trip cannot catch by comparison — `Object.keys(new Map())`
    // is `[]`, so it looks equal to the `{}` it would silently become.
    const outcome = await QUnitX.run(`${SCRIPTS}/unserializable-value-script.ts`).result();

    assert.ok(QUnitX.Failure.is(outcome), 'an unusable value rejects rather than resolving');
    const failure = outcome as QUnitX.AnyFailure;
    assert.strictEqual(failure.code, 'ScriptValueNotSerializable');
    const message = QUnitX.Failure.format(failure);
    assert.includes(message, 'index is a Map', 'the offending field is named, not just the value');
    assert.includes(message, 'unserializable-value-script.ts', 'and so is the script');
  });
});

module('API | run | refuses the old suite verb', { concurrency: true }, () => {
  // `run` meant "run this suite" until the script verb took the name. Every shape that could only
  // have meant the old verb has to say so, because running it as a script would be a silent
  // change of meaning in a published API.
  test('a directory is refused, naming test() instead', async (assert) => {
    const outcome = await QUnitX.run('test/fixtures').result();

    assert.ok(QUnitX.Failure.is(outcome), 'a directory does not run as a script');
    const failure = outcome as QUnitX.AnyFailure;
    assert.strictEqual(failure.code, 'NotAScriptFile');
    assert.includes(QUnitX.Failure.format(failure), 'a directory');
    assert.includes(QUnitX.Failure.format(failure), 'test(');
  });

  test('a trailing separator is refused without touching the filesystem', async (assert) => {
    // 'tests/' need not exist: the spelling alone says suite.
    const outcome = await QUnitX.run('no-such-directory-at-all/').result();

    const failure = outcome as QUnitX.AnyFailure;
    assert.strictEqual(failure.code, 'NotAScriptFile');
    assert.includes(QUnitX.Failure.format(failure), 'a directory');
  });

  test('a glob is refused', async (assert) => {
    const outcome = await QUnitX.run('test/**').result();

    const failure = outcome as QUnitX.AnyFailure;
    assert.strictEqual(failure.code, 'NotAScriptFile');
    assert.includes(QUnitX.Failure.format(failure), 'a glob');
    assert.includes(QUnitX.Failure.format(failure), 'test(');
  });

  test('an array of inputs is refused', async (assert) => {
    // The `run(['a.ts', 'b.ts'])` shorthand the suite verb accepted. TypeScript rejects it too;
    // this is the guard for callers who are not typechecked.
    const outcome = await QUnitX.run(['a.ts', 'b.ts'] as unknown as string).result();

    const failure = outcome as QUnitX.AnyFailure;
    assert.strictEqual(failure.code, 'NotAScriptFile');
    assert.includes(QUnitX.Failure.format(failure), 'a list of paths');
  });

  test('an options object is refused', async (assert) => {
    const outcome = await QUnitX.run({ inputs: ['test/'] } as unknown as string).result();

    const failure = outcome as QUnitX.AnyFailure;
    assert.strictEqual(failure.code, 'NotAScriptFile');
    assert.includes(QUnitX.Failure.format(failure), 'not a file path');
  });

  test('a missing file is reported as missing, not as the wrong verb', async (assert) => {
    await using directory = await tempDir('api-run-missing');
    const outcome = await QUnitX.run(path.join(directory.path, 'nope.ts')).result();

    const failure = outcome as QUnitX.AnyFailure;
    assert.strictEqual(failure.code, 'ScriptNotFound');
  });
});

module('API | run | laziness and cleanup', { concurrency: true }, () => {
  test('the Task is lazy — nothing runs until it is awaited', async (assert) => {
    await using directory = await tempDir('api-run-lazy');
    const script = path.join(directory.path, 'marker.ts');
    const marker = path.join(directory.path, 'ran.txt');
    await fs.writeFile(script, `await fetch('/write-marker').catch(() => {});\n`);

    const task = QUnitX.run(script);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.notOk(
      await fs
        .access(marker)
        .then(() => true)
        .catch(() => false),
      'building has not started before the await',
    );
    assert.ok(task instanceof Promise, 'it is still a Promise superset');
  });

  // The API's whole premise: a script that finishes lets the process exit. A leaked browser or
  // esbuild service is invisible from inside this suite, whose own process stays alive by design.
  test('no handle outlives the run, so a script that calls it can exit', async (assert) => {
    const permit = await acquireBrowser();
    try {
      const { stdout } = await spawnCapture(
        `node test/fixtures/api-run-exits.ts ${SCRIPTS}/exit-code-script.ts`,
        // spawnCapture does not inherit the environment, and without PATH the child cannot find
        // Chrome — it falls back to playwright's own download and dies on a missing one.
        { timeout: SCRIPT_TIMEOUT_MS, env: { ...process.env, FORCE_COLOR: '0' } },
      );
      const { result, handles } = JSON.parse(stdout.trim().split('\n').at(-1)!) as {
        result: QUnitX.ScriptResult;
        handles: string[];
      };

      assert.strictEqual(result.exitCode, 3, 'the child really ran the script');
      assert.deepEqual(
        handles.filter((handle) => handle === 'ProcessWrap'),
        [],
        `no child process outlives the Task, got ${JSON.stringify(handles)}`,
      );
    } finally {
      permit.release();
    }
  });
});
