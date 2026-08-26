import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
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

  // Every tool decides whether to colour by asking whether it is talking to a terminal, so the
  // question is whether the command gets THIS session's terminal or a pipe copied out of it. Only
  // a pty can answer it, and `script` is the one every Linux has; the macOS spelling differs and
  // Windows has none, so this asks on Linux and trusts `spawn` to be `spawn` elsewhere.
  if (process.platform === 'linux') {
    test('a command run from here is talking to the terminal, and can colour for it', async (assert) => {
      const asked = 'process.stdout.write(String(process.stdout.isTTY))';
      const result = await execute(
        `script -qec "node cli.ts repl --browser=chromium --output=tmp/run-${randomUUID()}" /dev/null`,
        { stdin: `:node -e "${asked}"\n.exit\n` },
      );

      assert.includes(result.stdout, 'true', 'a pipe would have answered undefined');
    });
  }

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

// Three questions about a value that do not need it printed: what came from where, what it is
// for, and where it is written.
module('Commands | repl | values', { concurrency: true }, () => {
  const helpers = (stdin: string) => repl(stdin, 'test/fixtures/repl-helpers.ts');

  test('.imported names what each file put in scope', async (assert) => {
    const result = await helpers('.imported\n');

    assert.exitCode(result, 0);
    assert.includes(result, 'test/fixtures/repl-helpers.ts:');
    assert.includes(result, 'double', 'and what it brought');
    assert.includes(await repl('.imported\n'), 'Nothing preloaded', 'with nothing, nothing');
  });

  test('.import brings a file in, under a name made from its path', async (assert) => {
    const result = await repl(
      '.import test/fixtures/repl-helpers.ts\nReplHelpers.GREETING\ndouble(21)\n',
    );

    assert.exitCode(result, 0);
    assert.includes(result, 'ReplHelpers, and GREETING, boom, double', 'and says what it brought');
    assert.includes(result, "'hello from the preload'", 'the namespace is the file');
    assert.includes(result, '42', 'and its exports are in scope on their own too');
  });

  test('.load is the same command, and the second word is the name', async (assert) => {
    const result = await repl('.load test/fixtures/repl-helpers.ts Helpers\nHelpers.GREETING\n');

    assert.includes(result, "'hello from the preload'");
    assert.includes(result, 'Helpers, and GREETING', 'named as asked rather than after the path');
  });

  test('an imported file registers its tests against the page’s own QUnit', async (assert) => {
    // The proof that `qunitx` is not bundled a second time: a second QUnit would collect this
    // test into a registry nothing flushes, which reads exactly like a test that never ran.
    const result = await repl('.import test/fixtures/repl-helpers.ts\n');

    assert.includes(result, 'ok 1 preloaded test');
  });

  test('importing again replaces what the last one left in scope', async (assert) => {
    // The reason to import twice is that the file changed. What the previous version put in scope
    // and this one does not is a value from a file that no longer exists.
    const result = await repl(
      '.import test/fixtures/repl-helpers.ts\n' +
        '.import test/fixtures/repl-helpers.ts Helpers\n' +
        'typeof ReplHelpers\n.imported\n',
    );

    assert.includes(result, "'undefined'", 'the name it used to go under is gone');
    assert.includes(result, 'test/fixtures/repl-helpers.ts: Helpers, GREETING', 'listed once');
  });

  test('JSON arrives parsed and anything else arrives as text', async (assert) => {
    const result = await repl(
      '.import package.json\nPackage.name\n.import README.md Readme\ntypeof Readme\n',
    );

    assert.includes(result, "'qunitx-cli'", 'parsed, so it can be read into');
    assert.includes(result, "'string'", 'and a file that is not data is its own text');
  });

  test('what cannot be brought in says why, and the session carries on', async (assert) => {
    const result = await repl('.import nope.ts\n.import lib\n.import package.json 3bad\n1 + 1\n');

    assert.exitCode(result, 0);
    assert.includes(result, 'nope.ts is not a file');
    assert.includes(result, 'lib is a directory');
    assert.includes(result, '3bad is not a name a value can be given');
    assert.includes(result, '2', 'and the prompt is still there afterwards');
  });

  test('a file that will not compile is reported rather than thrown', async (assert) => {
    await using directory = await tempDir('repl-import');
    const broken = path.join(directory.path, 'broken.ts');
    await fs.writeFile(broken, 'export const a = (;\n');
    const result = await repl(`.import ${path.relative(process.cwd(), broken)}\n1 + 1\n`);

    assert.includes(result, 'would not bundle');
    assert.includes(result, '2', 'and the session survives it');
  });

  test('.doc reads in the order the file does: where, what was said, then the code', async (assert) => {
    const result = await helpers('.doc double\n');

    assert.includes(result, 'test/fixtures/repl-helpers.ts:', 'where it is written');
    assert.includes(result, 'Doubles a number', 'the sentence above it');
    assert.includes(result, 'const answer = double(21)', 'with the example in it');
    assert.includes(result, 'export function double(value: number): number', 'and the signature');

    const at = (text: string) => result.stdout.indexOf(text);
    assert.true(
      at('repl-helpers.ts:') < at('Doubles a number') &&
        at('Doubles a number') < at('export function double'),
      'in that order — the signature last, where the eye lands before typing the call',
    );
  });

  test('a value with no comment still has a signature and a place', async (assert) => {
    // It used to answer "nothing written about boom", which is true and useless: the two things
    // it could say were both known.
    const result = await repl('.doc outer\n', 'test/fixtures/repl-stepping.ts');

    assert.includes(result, 'export function outer(): number');
    assert.includes(result, 'repl-stepping.ts:9');
    assert.notIncludes(result, 'nothing known', 'because something is');
  });

  test('.view on a name that is not a path shows the value, body and all', async (assert) => {
    const result = await repl('.view helper\n', 'test/fixtures/repl-stepping.ts');

    assert.includes(result, 'export function helper(value: number): number', 'the signature');
    assert.includes(result, 'const doubled = value * 2', 'and how it is written');
    assert.strictEqual(
      result.stdout.split('export function helper').length - 1,
      1,
      'once — the body opens with the signature, so printing both printed it twice',
    );
  });

  test('.view on a path is still a file', async (assert) => {
    const result = await repl('.view test/fixtures/repl-stepping.ts\n');

    assert.includes(result, '1 | //', 'numbered, as it always was');
  });

  test('.explain and `.h <value>` are the same question', async (assert) => {
    const [doc, explain, h] = await Promise.all([
      helpers('.doc double\n'),
      helpers('.explain double\n'),
      helpers('.h double\n'),
    ]);
    const said = (text: string) => text.split('\n').filter((line) => line.includes('Doubles'));

    assert.deepEqual(said(explain.stdout), said(doc.stdout));
    assert.deepEqual(said(h.stdout), said(doc.stdout));
  });

  test('`.h` on its own is the help', async (assert) => {
    const help = await repl('.h\n');

    assert.includes(help, '.imported', 'every command, one line each');
    assert.includes(help, '[alias .load]', 'with the other names for it at the end of its line');
    assert.notIncludes(help, '\n.load ', 'and not on a line of their own');
  });

  test('what has nothing to say says so', async (assert) => {
    assert.includes(await helpers('.doc GREETING\n'), 'nothing known about GREETING');
    assert.includes(await helpers('.doc\n'), 'Usage: .doc <value>');
    assert.includes(await helpers('.open GREETING\n'), 'nothing known about GREETING');
  });

  test('the short names reach the same command', async (assert) => {
    // A pipe has no terminal to hand to an editor, so all three say where it is instead — which
    // is also what makes this testable rather than a session waiting on a human who is not there.
    const [long, short] = await Promise.all([helpers('.open double\n'), helpers('.e double\n')]);
    const said = (text: string) => text.split('\n').filter((line) => line.includes('repl-helpers'));

    assert.includes(long, 'repl-helpers.ts:', 'the file and the line');
    assert.deepEqual(said(short.stdout), said(long.stdout), '`.e` is `.edit` is `.open`');
  });

  test('.pwd, .version and .search answer for the session', async (assert) => {
    const [pwd, version, search] = await Promise.all([
      repl('.pwd\n'),
      repl('.version\n'),
      helpers('.search preload\n'),
    ]);

    assert.includes(pwd, process.cwd(), 'the directory paths resolve against');
    assert.includes(version, '.', 'a version, whatever it is at the time');
    assert.includes(search, 'preloaded test', 'the test the filter matches');
    assert.includes(search, 'repl-helpers.ts:', 'and where it is declared');
    assert.includes(await helpers('.search zzz\n'), 'No tests match');
  });
});

// `.break` does two jobs, told apart by whether anything follows it: `node:repl` has always used
// it for abandoning a half-typed block and every debugger has always used it for setting a
// breakpoint, and both are what somebody typing that FORM means.
module('Commands | repl | breakpoints', { concurrency: true }, () => {
  const stepping = (stdin: string) => repl(stdin, 'test/fixtures/repl-stepping.ts');

  test('a place after it sets a breakpoint, and the page stops there', async (assert) => {
    const result = await stepping(
      '.break test/fixtures/repl-stepping.ts:4\nhelper(10)\n.locals\n.continue\n',
    );

    assert.includes(result, 'breakpoint 1 at test/fixtures/repl-stepping.ts:4');
    assert.includes(result, 'paused at helper', 'and stopped there without a `debugger` in it');
    assert.includes(result, 'value', 'with the frame to read');
  });

  test('nothing after it still abandons the unfinished input', async (assert) => {
    const result = await stepping('const a = {\n.break\n1 + 1\n');

    assert.includes(result, '2', 'the next line is a line again');
    assert.notIncludes(result, 'SyntaxError');
  });

  test('they can be listed and removed by number', async (assert) => {
    const result = await stepping(
      '.break test/fixtures/repl-stepping.ts:4\n' +
        '.break test/fixtures/repl-stepping.ts:12\n' +
        '.delete 1\n.breakpoints\n',
    );

    assert.includes(result, '2  test/fixtures/repl-stepping.ts:12', 'two is still two');
    assert.notIncludes(result, '1  test/fixtures/repl-stepping.ts:4', 'and one is gone');
  });

  test('a session with none says so', async (assert) => {
    assert.includes(await stepping('.breakpoints\n'), 'No breakpoints');
  });

  test('what cannot be done says why', async (assert) => {
    assert.includes(await stepping('.break oops\n'), 'not a place');
    assert.includes(await stepping('.delete\n'), 'Usage: .delete <number>');
    assert.includes(await stepping('.delete 9\n'), 'No breakpoint 9');
  });
});

// gdb's traversal commands take counts, and taking one and ignoring it is the worst way to be
// wrong: `.up 3` moved one frame and said nothing about the other two.
module('Commands | repl | traversal', { concurrency: true }, () => {
  const stepping = (stdin: string) => repl(stdin, 'test/fixtures/repl-stepping.ts');

  test('a count on a step is how many steps', async (assert) => {
    const [once, twice] = await Promise.all([
      stepping('outer()\n.step\n'),
      stepping('outer()\n.step 2\n'),
    ]);

    assert.includes(once, 'repl-stepping.ts:12', 'one step stays in the caller');
    assert.includes(twice, 'helper', 'and two reach the frame it calls');
    assert.notIncludes(twice, ':12:18\n  3 │', 'with only where it ended up shown');
  });

  test('`.frame` on its own says where you are without moving', async (assert) => {
    // `Number('')` is zero, which is why this is worth a test: it used to mean `.frame 0`.
    const result = await stepping('outer()\n.step 2\n.frame\n.backtrace\n');

    assert.includes(result, '> #0  helper', 'still the frame two steps left it in');
  });

  test('a count on `.up` is how many frames', async (assert) => {
    const result = await stepping('outer()\n.step 2\n.up 2\n.backtrace\n');

    assert.includes(result, '> #2', 'two frames up from where it stopped');
  });

  test('a negative count goes the other way, as in gdb', async (assert) => {
    const result = await stepping('outer()\n.step 2\n.up 2\n.up -1\n.backtrace\n');

    assert.includes(result, '> #1  outer', '`up -1` is `down 1`');
  });

  test('a count on the stack is how many frames to print', async (assert) => {
    const result = await stepping('outer()\n.step 2\n.backtrace 2\n');

    assert.includes(result, '#1  outer');
    assert.notIncludes(result, '#2', 'the innermost two, and no more');
  });

  test('`.back` goes back in execution order, which is toward the caller', async (assert) => {
    // The caller ran BEFORE the frame it called, so back is outward on the stack. gdb spells
    // `back` as an abbreviation of `backtrace`, which is its prefix matching rather than its
    // judgement, and reads wrong where somebody typing "back" means "take me back".
    const [viaUp, viaBack] = await Promise.all([
      stepping('outer()\n.step 2\n.up\n.backtrace\n'),
      stepping('outer()\n.step 2\n.back\n.backtrace\n'),
    ]);
    // `#\d`, so the banner — which carries a port, and two sessions do not share one — stays out.
    const frames = (text: string) => text.split('\n').filter((line) => /#\d/.test(line));

    assert.deepEqual(frames(viaBack.stdout), frames(viaUp.stdout));
    assert.includes(viaBack, '> #1  outer', 'one frame out from where it stopped');
  });

  test('`.here` says which frame is being read, and takes nothing to say it', async (assert) => {
    const result = await stepping('outer()\n.step 2\n.up\n.here\n');

    assert.includes(result, 'outer (test/fixtures/repl-stepping.ts:12', 'the frame `.up` moved to');
    assert.includes(await stepping('outer()\n.here 2\n'), 'Usage: .here', 'and nothing else');
  });

  test('what is not a count says how to use it', async (assert) => {
    assert.includes(await stepping('outer()\n.up zz\n'), 'Usage: .up [count]');
    assert.includes(await stepping('outer()\n.step zz\n'), 'Usage: .step [count]');
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

  test('.ls is the same command, under the name the hand types', async (assert) => {
    const [tree, ls] = await Promise.all([
      repl('.tree -L 1 lib/repl\n'),
      repl('.ls -L 1 lib/repl\n'),
    ]);
    // Past the banner, which names the port this session happened to get.
    const listing = (text: string) => text.split('\n').filter((line) => !line.startsWith('# '));

    assert.deepEqual(listing(ls.stdout), listing(tree.stdout));
    assert.includes(await repl('.ls cli.ts\n'), 'cli.ts is a file, not a directory');
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

// `readline` records history only on a terminal, so what a pipe can check is that the command
// answers at all — `Commands | repl | history` is where the listing itself is tested.
module('Commands | repl | .history', { concurrency: true }, () => {
  test('a count that is not one says how to use it', async (assert) => {
    assert.includes(await repl('.history zz\n'), 'Usage: .history [count]');
  });

  test('and the session carries on either way', async (assert) => {
    assert.includes(await repl('.history\n1 + 1\n'), '2');
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
