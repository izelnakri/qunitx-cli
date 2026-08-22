import { module, test } from 'qunitx';
import process from 'node:process';
import { execute, shellFails, spawnCapture } from '../helpers/shell.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import '../helpers/custom-asserts.ts';

// `qunitx repl` reads stdin, so a pipe is a full session: the same code path a terminal drives,
// minus the prompt. That is what makes the terminal half testable without a pty.
const repl = (stdin: string, args = '') =>
  execute(`node cli.ts repl --browser=chromium ${args}`.trim(), { stdin });

module('Commands | repl | a piped session', { concurrency: true }, () => {
  test('evaluates each line in the page and prints the answers in order', async (assert) => {
    const result = await repl("1 + 1\n'hi'\ndocument.querySelector('#qunit-fixture').tagName\n");

    assert.exitCode(result, 0);
    assert.includes(
      result,
      "2\n'hi'\n'DIV'\n",
      'one answer per line, in the order they were typed',
    );
  });

  test('does what only a browser REPL can — fetch the page’s own server', async (assert) => {
    const result = await repl("(await fetch('/tests.js')).status\n");

    assert.includes(result, '200');
  });

  test('a test typed at the prompt runs and reports as TAP', async (assert) => {
    const result = await repl(
      "test('adds', (a) => a.equal(1 + 1, 2))\ntest('breaks', (a) => a.equal(1, 2, 'nope'))\n",
    );

    assert.exitCode(result, 0, 'a failing test does not fail the session — this is a prompt');
    assert.includes(result, 'ok 1 adds');
    assert.includes(result, 'not ok 2 breaks');
    assert.includes(result, 'nope', 'with the assertion diagnostics a run would print');
  });

  test('an unfinished line is continued rather than reported as an error', async (assert) => {
    const result = await repl('const shape = {\n  a: 1,\n}\nshape\n');

    assert.includes(result, '{ a: 1 }');
    assert.notIncludes(result, 'SyntaxError');
  });

  test('an error prints as Uncaught, and the session carries on', async (assert) => {
    const result = await repl('boom()\n1 + 1\n');

    assert.exitCode(result, 0);
    assert.includes(result, 'Uncaught ReferenceError: boom is not defined');
    assert.includes(result, '2', 'the next line is still evaluated');
  });

  test('page console output reaches the terminal', async (assert) => {
    const result = await repl("console.log('from the page', { a: 1 })\n");

    assert.includes(result, 'from the page { a: 1 }');
  });

  test('dot commands work: .url prints the server, .exit ends the session', async (assert) => {
    const result = await repl('.url\n.exit\n1 + 1\n');

    assert.exitCode(result, 0);
    assert.regex(result, /http:\/\/localhost:\d+/);
    assert.notIncludes(result, '\n2\n', '.exit stops the session before the line after it');
  });

  test('an empty stdin opens and closes cleanly', async (assert) => {
    const result = await repl('');

    assert.exitCode(result, 0);
    assert.includes(result, 'qunitx repl');
  });
});

module('Commands | repl | inputs and refusals', { concurrency: true }, () => {
  test('named files are preloaded, announced, and their tests run once', async (assert) => {
    const result = await repl('double(21)\n', 'test/fixtures/repl-helpers.ts');

    assert.includes(result, '# loaded test/fixtures/repl-helpers.ts: GREETING, boom, double');
    assert.includes(result, 'ok 1 preloaded test');
    assert.includes(result, '42', 'and the file’s exports are callable at the prompt');
  });

  test('a preload file that is not there refuses to open, naming it', async (assert) => {
    const result = await shellFails(
      'node cli.ts repl --browser=chromium test/fixtures/no-such.ts',
      {
        stdin: '1 + 1\n',
      },
    );

    assert.exitCode(result, 1);
    assert.includes(
      { stdout: result.stdout + result.stderr, stderr: '' },
      'could not read test input',
      'the unreadable input names itself',
    );
  });

  test('a non-chromium browser is refused by name', async (assert) => {
    const result = await shellFails('node cli.ts repl --browser=webkit', { stdin: '1 + 1\n' });

    assert.exitCode(result, 1);
    assert.includes(
      { stdout: result.stdout + result.stderr, stderr: '' },
      'Chrome DevTools Protocol',
    );
  });
});

module('Commands | repl | lifecycle', { concurrency: true }, () => {
  test('closing a session releases every handle it opened', async (assert) => {
    // The bug this guards against has shipped here before: a session that closed the browser and
    // the server but left esbuild's service child ref'd, so the process never ended. The fixture
    // does not call process.exit — if anything is left holding the loop, this times out instead
    // of passing, and the printed census says what.
    const permit = await acquireBrowser();
    try {
      const result = await spawnCapture('node test/fixtures/repl-handles.ts', {
        env: { ...process.env, FORCE_COLOR: '0' },
        timeout: 120_000,
      });

      assert.exitCode(result, 0, 'the process ended on its own, with nothing keeping it alive');
      // The exit code above is the proof; the census names WHAT is still open when it fails. It is
      // matched by shape rather than emptiness because "empty" is not true on a healthy Windows
      // exit: Chrome's user-data-dir removal is still a dozen `FSReqCallback`s and a retry timer at
      // this point, and the process's own stdio is always there. A socket, a bound server or a
      // child process is the shape a live browser, an unclosed port or esbuild's service takes.
      const census = /HANDLES (.*)/.exec(result.stdout)?.[1] ?? '[]';
      const live = (JSON.parse(census) as string[]).filter((handle) =>
        /TCP|Socket|Server|Process/i.test(handle),
      );
      assert.deepEqual(live, [], `nothing live left after close(): ${census}`);
    } finally {
      permit.release();
    }
  });
});
