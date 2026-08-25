import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execute, shellFails, spawnCapture } from '../helpers/shell.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import { tempDir } from '../helpers/temp-dir.ts';
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

// A REPL is where you check what a file says before typing against it, and leaving the session to
// look costs every binding you built.
module('Commands | qunitx repl | .cat', { concurrency: true }, () => {
  test('prints a file, resolved against the working directory', async (assert) => {
    const result = await repl('.cat test/fixtures/repl-helpers.ts');

    assert.includes(result.stdout, "export const GREETING = 'hello from the preload'");
    assert.includes(result.stdout, 'fixture boom', 'the whole file, not the first line');
    assert.notIncludes(result.stdout, String.fromCharCode(27), 'and plainly, into a pipe');
  });

  test('.view is the same command for anyone without the muscle memory', async (assert) => {
    const [viaCat, viaView] = await Promise.all([
      repl('.cat test/fixtures/repl-helpers.ts'),
      repl('.view test/fixtures/repl-helpers.ts'),
    ]);

    // Ports differ between two concurrent sessions and say nothing about the command.
    const normalise = (text: string) => text.replace(/localhost:\d+/g, 'localhost:PORT');

    assert.strictEqual(normalise(viaView.stdout), normalise(viaCat.stdout));
  });

  test('a missing file is an answer, not a crash', async (assert) => {
    const result = await repl('.cat nope.ts\n1 + 1');

    assert.includes(result.stdout, 'no such file: nope.ts');
    assert.includes(result.stdout, '2', 'and the session carries on');
  });
});

// `:` is the shell, the way `:` is the command line in vim. A prompt you cannot run `git status`
// from is a prompt you keep leaving, and leaving costs every binding in the page.
module('Commands | qunitx repl | : runs a shell command', { concurrency: true }, () => {
  test('its output arrives in the session, and the page is untouched', async (assert) => {
    const result = await repl(':echo hello from the shell\n1 + 1\n');

    assert.includes(result.stdout, 'hello from the shell');
    assert.includes(result.stdout, '2', 'and the next line is still evaluated in the page');
  });

  test('a failing command reports its exit code rather than throwing', async (assert) => {
    const result = await repl(':exit 3\n1 + 1\n');

    assert.includes(result.stdout, 'exit 3');
    assert.includes(result.stdout, '2', 'the session carries on');
  });

  test('stderr comes through too', async (assert) => {
    const result = await repl(':echo trouble 1>&2\n');

    assert.includes(result.stdout + result.stderr, 'trouble');
  });

  test('shell lines are left out of .save', async (assert) => {
    // `.save` writes a file meant to be replayable JavaScript. A shell line is neither JavaScript
    // nor something to re-run by accident.
    await using directory = await tempDir('repl-save');
    const saved = path.join(directory.path, 'session.js');
    await repl(`1 + 1\n:echo not-javascript\n2 + 2\n.save ${saved}\n`);

    const contents = await fs.readFile(saved, 'utf8');
    assert.includes(contents, '1 + 1');
    assert.includes(contents, '2 + 2');
    assert.notIncludes(contents, 'not-javascript', 'the shell line is not replayable');
    assert.notIncludes(contents, ':echo');
  });
});

// A REPL is where you check what a file says before typing against it, and leaving the session to
// do that loses every binding you built.
module('Commands | repl | .cat', { concurrency: true }, () => {
  test('a file comes back numbered', async (assert) => {
    const result = await repl('.cat test/fixtures/repl-debugger.ts\n');

    assert.exitCode(result, 0);
    assert.includes(result, '3 | export function inspectMe', 'the line, with the line number');
    assert.includes(result, '5 |   debugger;', 'right-aligned against the longest of them');
  });

  test('a directory says what it is rather than printing nothing', async (assert) => {
    assert.includes(await repl('.cat lib\n'), 'lib is a directory');
  });

  test('a path that goes wrong names the part that was right', async (assert) => {
    // So the next attempt is a few keystrokes: on a terminal the prompt comes back holding it.
    const result = await repl('.cat lib/nowhere.ts\n');

    assert.includes(result, 'no such file: lib/nowhere.ts');
    assert.includes(result, 'lib/ exists', 'which is the part worth keeping');
  });

  test('nothing at all still says how to use it', async (assert) => {
    assert.includes(await repl('.cat\n'), 'Usage: .cat <file>');
  });
});

// A tree, and the two commands that reach it. `.view` shows whatever is there; `.tree` only ever
// shows a directory, because half the value of a narrow command is that it refuses what it is not
// for.
module('Commands | repl | .tree', { concurrency: true }, () => {
  test('a directory comes back as a tree', async (assert) => {
    const result = await repl('.tree -L 1 lib/repl\n');

    assert.exitCode(result, 0);
    assert.includes(result, 'lib/repl/', 'the root, said as a directory');
    assert.includes(result, '── files.ts');
    assert.includes(result, 'files', 'and the tally underneath');
  });

  test('depth is levels down, and nothing says all the way', async (assert) => {
    const [shallow, deep] = await Promise.all([repl('.tree -L 1 lib\n'), repl('.tree lib\n')]);

    assert.notIncludes(shallow, 'files.ts', 'one level stops at the directory names');
    assert.includes(deep, 'files.ts', 'and unasked goes all the way down');
  });

  test('.tree refuses a file, by name', async (assert) => {
    assert.includes(await repl('.tree cli.ts\n'), 'cli.ts is a file, not a directory');
  });

  test('.view shows a file or a directory, and .cat only a file', async (assert) => {
    const [viewed, catted] = await Promise.all([repl('.view lib/repl\n'), repl('.cat lib/repl\n')]);

    assert.includes(viewed, '── files.ts', '.view shows what is in there');
    assert.includes(catted, 'lib/repl is a directory', 'and .cat says what cat has always said');
  });
});

// `.clear` is about the screen. The half-typed input survives it, as it does in a shell.
module('Commands | repl | .clear', { concurrency: true }, () => {
  test('an unfinished input survives it', async (assert) => {
    const result = await repl('const half = {\n.clear\na: 1 }\nhalf.a\n');

    assert.includes(result, '1', 'the block finished on the other side of it');
    assert.notIncludes(result, 'SyntaxError');
  });

  test('nothing is written into a pipe, which has no screen to clear', async (assert) => {
    assert.notIncludes(await repl('.clear\n1 + 1\n'), String.fromCharCode(27));
  });
});

// An unfinished input is held here rather than handed to `node:repl`, which is what lets the
// prompt say how deep it is. The piped path proves the buffering; how it is drawn is a terminal
// concern, and `Repl | highlight | depth` is what counts the levels.
module('Commands | repl | unfinished input', { concurrency: true }, () => {
  test('a block spread over lines is one input', async (assert) => {
    const result = await repl('const shape = {\n  a: 1,\n  b: [2,\n  3],\n}\nshape.b[1]\n');

    assert.exitCode(result, 0);
    assert.includes(result, '3', 'the whole block ran as one thing');
    assert.notIncludes(result, 'SyntaxError', 'no line was evaluated on its own');
  });

  test('a brace inside a string does not open a level', async (assert) => {
    const result = await repl(`const a = { b: '}' }\na.b\n`);

    assert.includes(result, "'}'", 'the string closed the object, the brace in it did not');
  });

  test('.break abandons what was half-typed', async (assert) => {
    // Without it the next line continues a block nobody wants any more, and every line after it
    // is a syntax error in something invisible.
    const result = await repl('const a = {\n.break\n1 + 1\n');

    assert.includes(result, '2', 'the next line is a line again');
    assert.notIncludes(result, 'SyntaxError');
  });
});

// `.scope` and `.locals` answer the same question in the two states a session can be in, and
// `.continue` is what every other debugger calls resuming.
module('Commands | repl | scope and breakpoints', { concurrency: true }, () => {
  const DEBUGGED = 'test/fixtures/repl-debugger.ts';

  test('.scope lists what the session declared, with where it came from', async (assert) => {
    const result = await repl('const label = "one"\n.scope\n');

    assert.exitCode(result, 0);
    assert.includes(result, 'label', 'the name');
    assert.includes(result, "'one'", 'its value, rendered as the prompt renders it');
    assert.includes(result, 'line 1', 'and the input that declared it');
  });

  test('.scope on a session that has declared nothing says so', async (assert) => {
    assert.includes(await repl('.scope\n'), 'Nothing declared yet');
  });

  test('.locals points at `.scope` when nothing is stopped', async (assert) => {
    // Rather than printing an empty listing, which reads as "there are no locals" when what is
    // true is "there is no breakpoint".
    assert.includes(await repl('.locals\n'), 'Not paused');
  });

  test('.locals at a breakpoint is what the frame can see', async (assert) => {
    const result = await repl(`inspectMe()\n.locals\n.continue\n`, DEBUGGED);

    assert.includes(result, 'paused at', 'it stopped');
    assert.includes(result, 'answer', 'and the local is named');
    assert.includes(result, '42', 'with its value');
  });

  test('.continue carries on from a breakpoint, and so does .resume', async (assert) => {
    const carried = await repl('inspectMe()\n.continue\n6 * 7\n', DEBUGGED);
    const older = await repl('inspectMe()\n.resume\n6 * 7\n', DEBUGGED);

    assert.includes(carried, '42', 'the session is a session again');
    assert.includes(older, '42', 'the name it shipped with still works');
  });
});
