import fs from 'node:fs/promises';
import path from 'node:path';
import { module, test } from 'qunitx';
import { withRepl, captureStream } from './helpers.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import { outputDir, tempDir } from '../helpers/temp-dir.ts';
import * as QUnitX from '../../lib/api/index.ts';
import { streamConsole } from '../../lib/console.ts';
import '../helpers/custom-asserts.ts';

const PRELOAD = 'test/fixtures/repl-helpers.ts';

module('API | repl | evaluating in the page', { concurrency: true }, () => {
  test('answers with the page’s own values, not Node’s', async (assert) => {
    await withRepl({}, async (session) => {
      assert.equal((await session.eval('1 + 1')).output, '2');
      assert.equal((await session.eval("'hi'")).output, "'hi'");
      assert.equal((await session.eval('({ a: 1, b: [2, 3] })')).output, '{ a: 1, b: [ 2, 3 ] }');
      assert.equal(
        (await session.eval('document.title')).output,
        "'qunitx repl'",
        'there is a real document — this is the whole point of evaluating in the browser',
      );
      assert.equal(
        (await session.eval("document.querySelector('#qunit-fixture')")).output,
        '<div id="qunit-fixture"></div>',
        'a DOM node renders as its markup',
      );
    });
  });

  test('does what only a browser can: fetch its own server, and keep the DOM it built', async (assert) => {
    await withRepl({}, async (session) => {
      assert.equal(
        (await session.eval("(await fetch('/tests.js')).status")).output,
        '200',
        'top-level await against the session’s own origin',
      );
      await session.eval(
        "document.body.appendChild(Object.assign(document.createElement('p'), { id: 'note' }))",
      );
      assert.equal(
        (await session.eval("document.querySelector('#note').tagName")).output,
        "'P'",
        'the page persists between inputs — it is one document, not one per evaluation',
      );
    });
  });

  test('bindings persist, including one declared with await', async (assert) => {
    await withRepl({}, async (session) => {
      await session.eval('let counter = 1');
      await session.eval('counter += 1');
      assert.equal((await session.eval('counter')).output, '2');
      assert.equal(
        (await session.eval('let counter = 99')).output,
        'undefined',
        'REPL mode allows redeclaration, exactly as a devtools console does',
      );

      await session.eval("const later = await Promise.resolve('settled')");
      assert.equal((await session.eval('later')).output, "'settled'");
    });
  });

  test('a promise reports its state rather than being silently awaited', async (assert) => {
    await withRepl({}, async (session) => {
      assert.equal((await session.eval('Promise.resolve(5)')).output, 'Promise { <fulfilled> 5 }');
      assert.equal((await session.eval('new Promise(() => {})')).output, 'Promise { <pending> }');
    });
  });
});

module('API | repl | inputs that are not values', { concurrency: true }, () => {
  test('an unfinished input is reported as incomplete, and completes on the next line', async (assert) => {
    await withRepl({}, async (session) => {
      const first = await session.eval('const shape = {');

      assert.true(first.incomplete, 'nothing ran');
      assert.equal(first.output, '', 'and nothing was printed');
      assert.equal((await session.eval('const shape = { a: 1 }\n')).output, 'undefined');
      assert.equal((await session.eval('shape')).output, '{ a: 1 }');
    });
  });

  test('a real syntax error is reported instead of waiting for more input', async (assert) => {
    await withRepl({}, async (session) => {
      const result = await session.eval('const x = ;');

      assert.false(result.incomplete);
      assert.true(result.failed);
      assert.includes(result.output, 'SyntaxError');
    });
  });

  test('a thrown error comes back with its stack', async (assert) => {
    await withRepl({}, async (session) => {
      const result = await session.eval('boom()');

      assert.true(result.failed);
      assert.includes(result.output, 'ReferenceError: boom is not defined');
    });
  });

  test('an empty input is a no-op rather than an evaluation', async (assert) => {
    await withRepl({}, async (session) => {
      const result = await session.eval('   ');

      assert.deepEqual(
        { output: result.output, failed: result.failed, tests: result.tests.length },
        { output: '', failed: false, tests: 0 },
      );
    });
  });
});

module('API | repl | tests typed at the prompt', { concurrency: true }, () => {
  test('a test registered by an input runs immediately and is reported', async (assert) => {
    const output = captureStream();
    await withRepl({ reporter: 'tap', console: streamConsole(output) }, async (session) => {
      const result = await session.eval("test('adds', (a) => a.equal(1 + 1, 2))");

      assert.equal(result.tests.length, 1);
      assert.equal(result.tests[0].status, 'passed');
      assert.deepEqual(result.tests[0].fullName, ['adds']);
      assert.equal(result.output, '', 'the undefined a `test(…)` call returns is not printed');
      assert.includes(output.text(), 'ok 1 adds', 'reported through the run’s own reporters');
    });
  });

  test('run after run: a second batch is accepted after the first has finished', async (assert) => {
    // QUnit is built to run once per page load. The session puts its queue back in a state that
    // accepts more, which is what makes this a REPL rather than a one-shot page.
    await withRepl({}, async (session) => {
      await session.eval("test('first', (a) => a.true(true))");
      const second = await session.eval("test('second', (a) => a.true(true))");
      const third = await session.eval(
        "module('Cart', () => { test('third', (a) => a.true(true)) })",
      );

      assert.equal(second.tests.length, 1);
      assert.deepEqual(second.tests[0].fullName, ['second']);
      assert.equal(third.tests.length, 1, 'and a module registered later still runs');
      assert.deepEqual(third.tests[0].fullName, ['Cart', 'third']);
    });
  });

  test('a failing test reports as one — the prompt does not throw for it', async (assert) => {
    const output = captureStream();
    await withRepl({ reporter: 'tap', console: streamConsole(output) }, async (session) => {
      const result = await session.eval("test('breaks', (a) => a.equal(1, 2, 'nope'))");

      assert.false(result.failed, 'a failing test is a result, not an error from the input');
      assert.equal(result.tests[0].status, 'failed');
      assert.includes(output.text(), 'not ok 1 breaks');
      // QUnit deletes `actual` and `expected` from its assertions on the line after it emits
      // `testEnd`, so a payload captured any later reports every failure as `actual: null`.
      assert.deepEqual(
        result.tests[0].assertions?.map((one) => [one.actual, one.expected]),
        [[1, 2]],
        'the values are captured before QUnit reclaims them',
      );
      assert.includes(output.text(), 'actual: 1', 'and they reach the reporter');
    });
  });
});

module('API | repl | preloaded files', { concurrency: true }, () => {
  test('exports become globals, and the file’s own tests run as the session opens', async (assert) => {
    const output = captureStream();
    await withRepl(
      { inputs: [PRELOAD], reporter: 'tap', console: streamConsole(output) },
      async (session) => {
        assert.deepEqual(
          session.loaded.map(([file]) => file),
          [PRELOAD],
          'the session reports what it loaded, so the terminal can list it',
        );
        assert.deepEqual(session.loaded[0][1], ['ReplHelpers', 'GREETING', 'boom', 'double']);
        assert.equal(
          (await session.eval('ReplHelpers.GREETING')).output,
          "'hello from the preload'",
          'the file itself is in scope too, under the name its path spells',
        );
        assert.equal((await session.eval('double(21)')).output, '42');
        assert.equal((await session.eval('GREETING')).output, "'hello from the preload'");
        assert.includes(output.text(), 'ok 1 preloaded test');
      },
    );
  });

  test('a stack from preloaded code maps back to its own source', async (assert) => {
    await withRepl({ inputs: [PRELOAD] }, async (session) => {
      const result = await session.eval('boom()');

      assert.true(result.failed);
      assert.includes(result.output, 'Error: fixture boom');
      assert.includes(
        result.output,
        ' (test/fixtures/repl-helpers.ts:',
        'the bundle frame is resolved through the inline source map, not left as /tests.js — and ' +
          'in project coordinates, with no output-directory prefix in front of it',
      );
    });
  });

  test('the preload can be named positionally, alongside options', async (assert) => {
    // The shape every other verb takes — `test('test/', opts)`, `run('seed.ts', opts)`. Called
    // directly rather than through `withRepl`, because the helper only speaks the options form
    // and it is the two-argument call itself that is under test.
    await using directory = outputDir('api-repl-positional');
    const reported = captureStream();
    const permit = await acquireBrowser();
    const session = await QUnitX.repl(PRELOAD, {
      output: directory.path,
      reporter: 'tap',
      console: streamConsole(reported),
    });
    try {
      assert.deepEqual(
        session.loaded.map(([file]) => file),
        [PRELOAD],
        'the positional argument is the preload, not a test target',
      );
      assert.equal((await session.eval('double(21)')).output, '42');
      assert.includes(
        reported.text(),
        'ok 1 preloaded test',
        'the SECOND argument took effect too — a dropped one leaves this stream empty',
      );
    } finally {
      await session.close();
      permit.release();
    }
  });

  test('nothing is preloaded when no inputs are named', async (assert) => {
    await withRepl({}, async (session) => {
      assert.deepEqual(session.loaded, []);
      assert.equal(
        (await session.eval('typeof double')).output,
        "'undefined'",
        'a bare `qunitx repl` does not drag the project’s test files in',
      );
      assert.equal((await session.eval('typeof test')).output, "'function'", 'qunitx still is');
    });
  });
});

module('API | repl | lifecycle', { concurrency: true }, () => {
  test('reload drops every binding and keeps the session usable', async (assert) => {
    await withRepl({}, async (session) => {
      await session.eval('globalThis.kept = 1');
      await session.reload();

      assert.equal((await session.eval('typeof kept')).output, "'undefined'");
      assert.equal((await session.eval('1 + 1')).output, '2', 'and the page still answers');
    });
  });

  test('a closed session answers rather than hanging', async (assert) => {
    const session = await QUnitX.repl({ output: 'tmp/repl-closed' });
    await session.close();
    await session.close(); // idempotent

    const result = await session.eval('1 + 1');
    assert.true(result.failed);
    assert.includes(result.output, 'closed');
  });

  test('firefox and webkit are refused by name, before anything is launched', async (assert) => {
    const outcome = await QUnitX.repl({ browser: 'firefox' }).result();

    assert.true(QUnitX.Failure.is(outcome));
    assert.true(QUnitX.Failure.hasCode(outcome, 'UnsupportedBrowser'));
    assert.includes(QUnitX.Failure.format(outcome), 'chromium');
  });
});

// `.url` invites you to open the session in your own browser, and an init script reaches only the
// page playwright drives. The bundle's first line asks the harness to load the preloads, so
// without it the tab died on arrival with `Cannot read properties of undefined (reading 'load')`.
module('API | repl | opening the page yourself', { concurrency: true }, () => {
  test('the harness ships with the document, not only with the init script', async (assert) => {
    // Fetched rather than opened in a second browser: what changed is what the SERVER sends, and
    // asserting that needs no engine — which also keeps this off whichever browsers a given CI
    // lane happens to have installed.
    await withRepl({ inputs: [PRELOAD] }, async (session) => {
      const html = await fetch(session.url).then((response) => response.text());

      assert.includes(html, '__qunitxHarness', 'a plain visitor gets one too');
      assert.ok(
        html.indexOf('__qunitxHarness') < html.indexOf('/tests.js'),
        'and gets it BEFORE the bundle that calls it — the order is the whole fix',
      );
    });
  });
});

// A `debugger` statement only stops a page that has a debugger attached. Headless, with nothing
// attached, it is a no-op — the page runs straight past it and the prompt answers `undefined`,
// which is the least useful thing a REPL can say about a breakpoint. So the session attaches one.
module('API | repl | debugger', { concurrency: true }, () => {
  const DEBUGGED = 'test/fixtures/repl-debugger.ts';

  test('it stops the page, and says where in the source', async (assert) => {
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      assert.strictEqual(session.pausedAt, null, 'not paused before anything runs');

      const result = await session.eval('inspectMe()');

      assert.ok(result.pausedAt, 'the call came back as a pause rather than a value');
      assert.includes(result.pausedAt!, 'inspectMe', 'named by the function it stopped in');
      assert.includes(
        result.pausedAt!,
        'test/fixtures/repl-debugger.ts:5',
        'and by the source line, not the bundle line the page actually ran',
      );
      await session.resume();
    });
  });

  test('what you type while paused sees the locals at the breakpoint', async (assert) => {
    // The whole point of stopping. Evaluating against the globals instead would answer a question
    // nobody asked — `answer` does not exist out there.
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      await session.eval('inspectMe()');

      assert.strictEqual((await session.eval('answer')).output, '42');
      assert.strictEqual((await session.eval('answer * 2')).output, '84');
      await session.resume();
    });
  });

  test('what you declare while stopped lasts as long as the breakpoint', async (assert) => {
    // `Debugger.evaluateOnCallFrame` runs each input in a scope of its own and throws it away, so
    // a `let` there used to answer `undefined` and then not exist — which looks like it worked.
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      await session.eval('inspectMe()');

      assert.strictEqual((await session.eval('let me = { age: 32 }')).output, 'undefined');
      assert.strictEqual((await session.eval('me.age')).output, '32', 'it is still there');

      const doubled = await session.eval('const doubled = answer * 2');
      assert.strictEqual(doubled.output, 'undefined');
      assert.strictEqual(
        (await session.eval('doubled')).output,
        '84',
        'and its initializer saw the frame, which is the whole point of declaring it here',
      );
      await session.resume();
    });
  });

  test('what the block owns goes when the breakpoint does', async (assert) => {
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      await session.eval('inspectMe()');
      await session.eval('let me = { age: 32 }');

      await session.resume();

      assert.true((await session.eval('me')).failed, 'the session that carries on has no `me`');
      assert.strictEqual(
        (await session.eval('let me = "mine"')).output,
        'undefined',
        'and the name is free for it to declare its own',
      );
      assert.strictEqual((await session.eval('me')).output, "'mine'");
    });
  });

  test('what JavaScript hoists out of a block is still there afterwards', async (assert) => {
    // `var` and `function` are not block-scoped anywhere else, and a prompt where they vanished
    // would be a prompt with its own rules.
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      await session.eval('inspectMe()');
      await session.eval('var kept = "sticky"');
      await session.eval('function greet() { return "hi" }');
      await session.eval('const gone = 1');

      await session.resume();

      assert.strictEqual((await session.eval('kept')).output, "'sticky'", 'var stays');
      assert.strictEqual((await session.eval('greet()')).output, "'hi'", 'and so does function');
      assert.true((await session.eval('gone')).failed, 'where const went with its block');
    });
  });

  test('a declaration at a breakpoint shadows one of the same name outside it', async (assert) => {
    // The reason a binding cannot simply be written to `globalThis`: a top-level `let` is a global
    // LEXICAL binding, and one of those wins over a property of the same name. The inner one has
    // to arrive as something that shadows it.
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      await session.eval('let me = { age: 32 }');
      await session.eval('inspectMe()');

      assert.strictEqual(
        (await session.eval('me')).output,
        '{ age: 32 }',
        'the outer one, until something says otherwise',
      );

      await session.eval('let me = { age: 33 }');

      assert.strictEqual((await session.eval('me')).output, '{ age: 33 }', 'and now the inner');

      await session.resume();

      assert.strictEqual(
        (await session.eval('me')).output,
        '{ age: 32 }',
        'and the outer one is untouched by any of it',
      );
    });
  });

  test('what was declared at the breakpoint can be assigned to there', async (assert) => {
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      await session.eval('inspectMe()');
      await session.eval('let count = 1');
      await session.eval('count = count + 1');

      assert.strictEqual((await session.eval('count')).output, '2', 'the assignment stuck');
      await session.resume();
    });
  });

  test('resuming lets it carry on, and the session is a session again', async (assert) => {
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      await session.eval('inspectMe()');
      assert.ok(session.pausedAt, 'paused');

      await session.resume();

      assert.strictEqual(session.pausedAt, null, 'and running again');
      assert.strictEqual((await session.eval('6 * 7')).output, '42');
    });
  });

  test('the frame comes with the source it stopped in', async (assert) => {
    // The ORIGINAL source, not the bundle the page actually ran — the line number has to point at
    // something a person can read.
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      assert.strictEqual(await session.frameSource(), null, 'nothing is stopped yet');

      await session.eval('inspectMe()');
      const frame = await session.frameSource();

      assert.ok(frame, 'a pause knows where it is');
      assert.includes(frame!.text, 'export function inspectMe', 'the file, as it is written');
      assert.strictEqual(frame!.line, 5, 'and the line the fixture has `debugger` on');
      assert.strictEqual(
        frame!.text.split('\n')[frame!.line - 1]?.trim(),
        'debugger;',
        'which is the line the excerpt will mark',
      );
      await session.resume();
    });
  });

  test('a function typed at the prompt has its source read from the page', async (assert) => {
    // It exists nowhere else — there is no file to read, and the page is the only one that knows.
    await withRepl({}, async (session) => {
      await session.eval('function typed() { debugger; return 1 }');
      await session.eval('typed()');

      const frame = await session.frameSource();

      assert.ok(frame, 'a pause in typed input still knows where it is');
      assert.includes(frame!.text, 'function typed()');
      await session.resume();
    });
  });

  test('resuming a page that is not paused does nothing', async (assert) => {
    await withRepl({}, async (session) => {
      await session.resume();

      assert.strictEqual(session.pausedAt, null);
      assert.strictEqual((await session.eval('1 + 1')).output, '2', 'still usable');
    });
  });
});

// What both TAB and the greyed-out suggestion are drawn from. Asking the page beats ranking your
// history: `window` is completable in a session that has never mentioned it, and a name declared
// at the prompt is completable the moment it exists.
module('API | repl | names', { concurrency: true }, () => {
  test('the page’s own globals, which no history could have known', async (assert) => {
    await withRepl({}, async (session) => {
      const names = await session.names('');

      assert.true(names.includes('window'), 'a global nobody typed');
      assert.true(names.includes('document'));
      assert.false(names.includes('inspectMe'), 'and nothing that was never loaded');
    });
  });

  test('what you declare becomes completable, `const` included', async (assert) => {
    // `let` and `const` at top level are NOT on `globalThis` — they live in the global lexical
    // scope, and a completer that only reads `globalThis` never sees half of what you declared.
    await withRepl({}, async (session) => {
      await session.eval('const label = "one"');
      await session.eval('globalThis.total = 42');

      const names = await session.names('');

      assert.true(names.includes('label'), 'the lexical scope, which globalThis does not carry');
      assert.true(names.includes('total'));
    });
  });

  test('properties come off the whole prototype chain', async (assert) => {
    await withRepl({}, async (session) => {
      const names = await session.names('document');

      assert.true(names.includes('title'), 'its own');
      assert.true(names.includes('querySelector'), "and Document.prototype's");
      assert.true(names.includes('addEventListener'), 'as far up as EventTarget');
    });
  });

  test('nothing that would have to be run to answer', async (assert) => {
    await withRepl({}, async (session) => {
      await session.eval('globalThis.calls = 0');
      await session.eval('globalThis.sideEffect = () => { calls += 1; return document }');

      assert.deepEqual(await session.names('sideEffect()'), [], 'not a path, so not evaluated');
      assert.strictEqual(
        (await session.eval('calls')).output,
        '0',
        'and the page is untouched — a keystroke is not consent to call your function',
      );
    });
  });
});

// `step`, `next` and `finish`, as every debugger since gdb has named them. Also the only way INTO
// another frame from a breakpoint: V8 turns breakpoints off for the length of a debugger
// evaluation, so a `debugger` inside something you call while stopped does nothing at all.
module('API | repl | stepping', { concurrency: true }, () => {
  const STEPPING = 'test/fixtures/repl-stepping.ts';
  const DEBUGGED = 'test/fixtures/repl-debugger.ts';
  const at = (where: string | null) => (where ?? '').replace(/^.*\((.*)\)$/, '$1');

  test('`next` runs the line without entering what it calls', async (assert) => {
    await withRepl({ inputs: [STEPPING] }, async (session) => {
      await session.eval('outer()');

      const where = await session.step('over');

      assert.includes(where ?? '', 'outer', 'still in the frame it started in');
      assert.includes(at(where), 'repl-stepping.ts:12', 'and on the line after the breakpoint');
      await session.resume();
    });
  });

  test('`step` goes into it', async (assert) => {
    await withRepl({ inputs: [STEPPING] }, async (session) => {
      await session.eval('outer()');
      await session.step('into');

      const inside = await session.step('into');

      assert.includes(inside ?? '', 'helper', 'the frame it called');
      assert.includes(at(inside), 'repl-stepping.ts:4');
    });
  });

  test('the locals are the ones where it stopped', async (assert) => {
    // Stepping moves the frame, and everything a breakpoint answers has to move with it.
    await withRepl({ inputs: [STEPPING] }, async (session) => {
      await session.eval('outer()');
      await session.step('into');
      await session.step('into');

      const locals = (await session.locals()).map((entry) => entry.name);

      assert.true(locals.includes('value'), "the called frame's argument");
      assert.false(locals.includes('start'), 'and not the caller’s');
      assert.strictEqual((await session.eval('value')).output, '21', 'and it evaluates there');
    });
  });

  test('`finish` runs until the frame returns', async (assert) => {
    await withRepl({ inputs: [STEPPING] }, async (session) => {
      await session.eval('outer()');
      await session.step('into');
      await session.step('into');

      const out = await session.step('out');

      assert.includes(out ?? '', 'outer', 'back in the caller');
      await session.resume();
    });
  });

  test('the source moves with the step', async (assert) => {
    await withRepl({ inputs: [STEPPING] }, async (session) => {
      await session.eval('outer()');
      await session.step('into');
      await session.step('into');

      const frame = await session.frameSource();

      assert.strictEqual(frame?.line, 4, 'the line it is on now');
      await session.resume();
    });
  });

  test('a step off the end does not stop the next thing you type', async (assert) => {
    // A step request that finds nothing to stop in outlives the run it was made for, and V8
    // spends it on whatever runs next — which is whatever gets typed at the prompt after it.
    await withRepl({ inputs: [STEPPING] }, async (session) => {
      await session.eval('outer()');
      await session.step('out');

      assert.strictEqual(await session.step('out'), null, 'nothing left to stop in');
      assert.strictEqual(session.pausedAt, null, 'so the page is running');

      const after = await session.eval('1 + 1');

      assert.strictEqual(after.output, '2', 'and the next line is answered');
      assert.strictEqual(session.pausedAt, null, 'rather than stopped on');
    });
  });

  test('stepping a page that is not paused does nothing', async (assert) => {
    await withRepl({}, async (session) => {
      assert.strictEqual(await session.step('into'), null);
      assert.strictEqual((await session.eval('1 + 1')).output, '2', 'and it stays usable');
    });
  });

  test('a `debugger` in what you call while stopped is not a second pause', async (assert) => {
    // V8's own rule, not this REPL's: breakpoints are off for the length of a debugger evaluation.
    // Worth a test because it looks like a bug and is not one, and because stepping is the answer.
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      await session.eval('inspectMe()');
      const where = session.pausedAt;

      const again = await session.eval('inspectMe()');

      assert.strictEqual(again.output, '42', 'it ran straight through and answered');
      assert.strictEqual(session.pausedAt, where, 'and the session is where it already was');
      await session.resume();
    });
  });
});

// A REPL's whole value is the page it is holding, so whether there still IS one is worth asking
// directly rather than inferring from whatever a failed command threw.
module('API | repl | liveness', { concurrency: true }, () => {
  test('a session with a page is alive, and stops being once it is closed', async (assert) => {
    await using output = outputDir('api-repl-alive');
    const permit = await acquireBrowser();
    const session = await QUnitX.repl({ output: output.path });
    try {
      assert.true(session.alive(), 'a session that just opened has a page');

      await session.close();

      assert.false(session.alive(), 'and none afterwards');
    } finally {
      permit.release();
    }
  });

  test('being alive is about the page, not about the last command', async (assert) => {
    // The distinction the terminal rests on: a failed command means "that did not work", and a
    // page that has gone means "nothing will".
    await withRepl({}, async (session) => {
      const threw = await session.eval('nope.nope');

      assert.true(threw.failed, 'the command failed');
      assert.true(session.alive(), 'and the session is fine');
    });
  });
});

// What a value IS, without printing it: which file put it in scope, and where it was written.
module('API | repl | values', { concurrency: true }, () => {
  const HELPERS = 'test/fixtures/repl-helpers.ts';

  test('what each preloaded file put in scope, and what kind each is', async (assert) => {
    // The kind is a theme capture rather than a JavaScript type, because it exists to be
    // coloured — a list of names says nothing about what they are.
    await withRepl({ inputs: [HELPERS] }, async (session) => {
      const [file] = await session.imported();

      assert.strictEqual(file?.file, HELPERS);
      assert.deepEqual(
        file?.names.filter((entry) => ['double', 'GREETING'].includes(entry.name)),
        [
          { name: 'GREETING', capture: '@string' },
          { name: 'double', capture: '@function' },
        ],
        'a string reads as a string and a function as a function',
      );
    });
  });

  test('nothing preloaded is nothing imported', async (assert) => {
    await withRepl({}, async (session) => {
      assert.deepEqual(await session.imported(), []);
    });
  });

  test('where a value was written', async (assert) => {
    await withRepl({ inputs: [HELPERS] }, async (session) => {
      const at = await session.declaredAt('double');

      assert.strictEqual(at?.file, HELPERS, 'the file, not the bundle it was built into');
      // Read back rather than hardcoded: the line is only right if it points at the declaration,
      // and a number in a test says nothing about whether it does.
      const source = await fs.readFile(at?.file ?? '', 'utf8');
      assert.includes(
        source.split('\n')[(at?.line ?? 0) - 1] ?? '',
        'export function double',
        'the line it names is the line it is written on',
      );
    });
  });

  test('and the things that have nowhere to point at', async (assert) => {
    await withRepl({ inputs: [HELPERS] }, async (session) => {
      assert.strictEqual(await session.declaredAt('GREETING'), null, 'V8 places functions only');
      assert.strictEqual(await session.declaredAt('nope.nope'), null, 'and nothing that throws');
      assert.strictEqual(await session.declaredAt(''), null);
    });
  });

  test('asking where something is does not run it', async (assert) => {
    // `.doc save()` must not save.
    await withRepl({}, async (session) => {
      await session.eval('globalThis.ran = 0');
      await session.eval('globalThis.sideEffect = () => { ran += 1; return 1 }');

      assert.strictEqual(await session.declaredAt('sideEffect()'), null);
      assert.strictEqual((await session.eval('ran')).output, '0', 'it was never called');
    });
  });
});

// A breakpoint without editing the file to put a `debugger` in it. The line is yours, not the
// bundle's — mapped through the same source map that turns a stack frame back into a file you
// wrote, only in the other direction.
module('API | repl | breakpoints', { concurrency: true }, () => {
  const STEPPING = 'test/fixtures/repl-stepping.ts';

  test('the page stops at a line nobody put a `debugger` on', async (assert) => {
    await withRepl({ inputs: [STEPPING] }, async (session) => {
      const set = await session.addBreakpoint(`${STEPPING}:4`);

      assert.deepEqual(set, { index: 1, where: `${STEPPING}:4` });

      const result = await session.eval('helper(10)');

      assert.ok(result.pausedAt, 'the call stopped');
      assert.includes(result.pausedAt!, 'helper', 'in the function the line is in');
      assert.includes(result.pausedAt!, `${STEPPING}:4`, 'on the line that was asked for');
      assert.strictEqual((await session.eval('value')).output, '10', 'with its frame to read');
      await session.resume();
    });
  });

  test('a line with no code on it lands on the next one that has some', async (assert) => {
    // Line 5 of the fixture is blank. Refusing it would answer "there is nothing there" to a
    // perfectly reasonable request, so it moves and says where it went.
    await withRepl({ inputs: [STEPPING] }, async (session) => {
      const set = await session.addBreakpoint(`${STEPPING}:5`);

      assert.deepEqual(set, { index: 1, where: `${STEPPING}:6` }, 'the return, one line down');
    });
  });

  test('what cannot be a breakpoint says why', async (assert) => {
    await withRepl({ inputs: [STEPPING] }, async (session) => {
      assert.includes(String(await session.addBreakpoint('oops')), 'not a place');
      assert.includes(
        String(await session.addBreakpoint('nowhere.ts:3')),
        'not a file this session bundled',
      );
    });
  });

  test('they are numbered once, and keep their numbers', async (assert) => {
    // Somebody who has just read a list and typed `.delete 1` should not find that 2 became 1.
    await withRepl({ inputs: [STEPPING] }, async (session) => {
      await session.addBreakpoint(`${STEPPING}:4`);
      await session.addBreakpoint(`${STEPPING}:12`);

      assert.deepEqual(
        session.breakpoints().map((breakpoint) => breakpoint.index),
        [1, 2],
      );
      assert.true(await session.removeBreakpoint(1));
      assert.deepEqual(
        session.breakpoints(),
        [{ index: 2, where: `${STEPPING}:12` }],
        'the one that is left is still number two',
      );
      assert.false(await session.removeBreakpoint(9), 'and there is no number nine');
    });
  });

  test('a removed breakpoint stops stopping the page', async (assert) => {
    await withRepl({ inputs: [STEPPING] }, async (session) => {
      const set = await session.addBreakpoint(`${STEPPING}:4`);
      await session.removeBreakpoint((set as { index: number }).index);

      const result = await session.eval('helper(10)');

      assert.strictEqual(result.pausedAt, undefined, 'it ran through');
      assert.strictEqual(result.output, '20', 'and answered');
    });
  });
});

// A breakpoint is rarely only about the line it stopped on — the answer is as often in who called
// it. gdb's `backtrace`, `frame`, `up` and `down`, under gdb's names.
module('API | repl | the stack', { concurrency: true }, () => {
  const STEPPING = 'test/fixtures/repl-stepping.ts';

  /** Stopped two calls deep, which is the shallowest stack worth walking. */
  const inside = async (session: ReplSession) => {
    await session.eval('outer()');
    await session.step('into');
    await session.step('into');
  };

  test('the stack is innermost first, and says where it is being read', async (assert) => {
    await withRepl({ inputs: [STEPPING] }, async (session) => {
      await inside(session);
      const frames = session.backtrace();

      assert.includes(frames[0]?.where ?? '', 'helper', 'frame 0 is where it stopped');
      assert.includes(frames[1]?.where ?? '', 'outer', 'and frame 1 is who called it');
      assert.true(frames[0]?.selected, 'a pause is read innermost until it is told otherwise');
      assert.deepEqual(
        frames.map((frame) => frame.index),
        frames.map((_, index) => index),
        'numbered the way gdb numbers them',
      );
      await session.resume();
    });
  });

  test('choosing a frame moves everything the pause answers', async (assert) => {
    await withRepl({ inputs: [STEPPING] }, async (session) => {
      await inside(session);

      assert.true(
        (await session.locals()).some((entry) => entry.name === 'value'),
        "the called frame's argument, while that frame is the one being read",
      );

      const where = session.selectFrame(1);

      assert.includes(where ?? '', 'outer');
      assert.false(
        (await session.locals()).some((entry) => entry.name === 'value'),
        'and now the caller, which has no `value` in it',
      );
      assert.strictEqual((await session.frameSource())?.line, 12, 'the line THAT frame is on');
      assert.true(session.backtrace()[1]?.selected, 'and the stack says which one is being read');
      await session.resume();
    });
  });

  test('a frame that is not on the stack is not chosen', async (assert) => {
    await withRepl({ inputs: [STEPPING] }, async (session) => {
      await inside(session);

      assert.strictEqual(session.selectFrame(99), null);
      assert.strictEqual(session.selectFrame(-1), null, 'nor one before the first');
      assert.true(session.backtrace()[0]?.selected, 'and nothing moved');
      await session.resume();
    });
  });

  test('a page that is not stopped has no stack', async (assert) => {
    await withRepl({}, (session) => {
      assert.deepEqual(session.backtrace(), []);
      assert.strictEqual(session.selectFrame(0), null);
    });
  });

  test('resuming forgets the stack it was reading', async (assert) => {
    await withRepl({ inputs: [STEPPING] }, async (session) => {
      await inside(session);
      session.selectFrame(1);

      await session.resume();

      assert.deepEqual(session.backtrace(), [], 'there is no frame to be in');
    });
  });
});

// Two readers for the two states a session is in. Running, the interesting names are the ones this
// session put on the page — not the several hundred a browser starts with, which is a list nobody
// reads. Stopped at a breakpoint, they are the ones the frame can see.
module('API | repl | scope', { concurrency: true }, () => {
  const DEBUGGED = 'test/fixtures/repl-debugger.ts';
  const named = (entries: Array<{ name: string }>) => entries.map((entry) => entry.name);

  test('what this session added, and where each of it came from', async (assert) => {
    await withRepl({}, async (session) => {
      assert.deepEqual(await session.scope(), [], 'a fresh session has added nothing');

      await session.eval('const label = "one"');
      await session.eval('globalThis.total = 42');
      const entries = await session.scope();

      assert.deepEqual(named(entries), ['label', 'total'], 'in the order they were declared');
      assert.deepEqual(
        entries.map((entry) => entry.where),
        ['line 1', 'line 2'],
        'each attributed to the input that declared it',
      );
      assert.includes(entries[0]!.value, "'one'", 'rendered the way the prompt renders it');
      assert.false(named(entries).includes('document'), 'and not the browser’s own globals');
    });
  });

  test('a preloaded export is attributed to the file it came from', async (assert) => {
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      const entries = await session.scope();
      const loaded = entries.find((entry) => entry.name === 'inspectMe');

      assert.ok(loaded, 'a preloaded export is part of what this session put there');
      assert.strictEqual(loaded!.where, DEBUGGED, 'and a file is a better answer than a line');
      assert.includes(loaded!.value, '[Function: inspectMe]', 'named, not printed as its source');
    });
  });

  test('locals are the frame’s, and only the frame’s', async (assert) => {
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      assert.deepEqual(await session.locals(), [], 'nothing is in scope while nothing is stopped');

      await session.eval('inspectMe()');
      const entries = await session.locals();

      assert.deepEqual(named(entries), ['answer'], 'the one local at the breakpoint');
      assert.includes(entries[0]!.value, '42');
      // The closure around a bundled function is the WHOLE BUNDLE — every name QUnit and the
      // runtime declare. Listing it buries the one name the breakpoint is about.
      assert.false(named(entries).includes('__defProp'), 'and not the bundle it was compiled into');
      await session.resume();
    });
  });

  test('a scope survives being read while the page is stopped', async (assert) => {
    // Everything that answers here has to read the isolate rather than run in it: a paused page
    // never answers an evaluation, so a `.scope` at a breakpoint would hang the prompt instead.
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      await session.eval('const label = "one"');
      await session.eval('inspectMe()');

      const entries = await session.scope();

      assert.true(named(entries).includes('label'), 'still answers, and still says what it added');
      await session.resume();
    });
  });
});

// An answer offered before Enter has to be FREE. V8 refuses to run anything with a side effect for
// this, which is what makes evaluating on a keystroke safe rather than merely fast.
module('API | repl | preview', { concurrency: true }, () => {
  test('a pure expression answers before it is run for real', async (assert) => {
    await withRepl({}, async (session) => {
      assert.strictEqual(await session.preview('1 + 1'), '2');
      assert.strictEqual(await session.preview('[1, 2].map((n) => n * 2)'), '[ 2, 4 ]');
      assert.includes(await session.preview('document.title'), 'qunitx repl');
    });
  });

  test('anything that would CHANGE something answers nothing at all', async (assert) => {
    // The property the whole feature rests on: `deleteEverything()` typed at a prompt must not
    // delete everything because it was typed.
    await withRepl({}, async (session) => {
      assert.strictEqual(await session.preview('globalThis.zap = 1'), '', 'an assignment');
      assert.strictEqual(await session.preview('const declared = 1'), '', 'a declaration');
      assert.strictEqual(
        await session.preview('document.body.appendChild(document.createElement("p"))'),
        '',
        'and a call that mutates the page',
      );

      assert.strictEqual(
        (await session.eval('typeof globalThis.zap')).output,
        "'undefined'",
        'none of it happened',
      );
      assert.strictEqual(
        (await session.eval('document.querySelectorAll("p").length')).output,
        '0',
        'and the page is as it was',
      );
    });
  });

  test('what cannot be answered quickly is not answered', async (assert) => {
    await withRepl({}, async (session) => {
      assert.strictEqual(await session.preview('for (;;) {}'), '', 'a loop that never ends');
      assert.strictEqual(await session.preview('nope.nope'), '', 'and one that throws');
      assert.strictEqual((await session.eval('1 + 1')).output, '2', 'the session carries on');
    });
  });

  test('a stopped page is not asked, because a stopped page does not answer', async (assert) => {
    await withRepl({ inputs: ['test/fixtures/repl-debugger.ts'] }, async (session) => {
      await session.eval('inspectMe()');

      assert.strictEqual(await session.preview('1 + 1'), '', 'and the prompt keeps taking keys');
      await session.resume();
    });
  });
});

// A file in scope and a file on disk are the same file, and the second one changes while the
// session that loaded the first is still open.
module('API | repl | a file that changed on disk', { concurrency: true }, () => {
  test('refresh runs it again the way it came in', async (assert) => {
    await using directory = await tempDir('api-repl-refresh');
    const live = path.join(directory.path, 'live-module.ts');
    await fs.writeFile(live, 'export const first = 1;\n');

    await withRepl({}, async (session) => {
      const brought = await session.importFile(live);
      assert.deepEqual(
        typeof brought === 'string' ? brought : brought.names,
        ['LiveModule', 'first'],
        'in scope under the name its path spells',
      );

      await fs.writeFile(live, 'export const first = 1;\nexport const second = 2;\n');
      const again = await session.refresh(live);

      assert.deepEqual(again, ['LiveModule', 'first', 'second'], 'and again, with what is new');
      assert.equal((await session.eval('second')).output, '2', 'answering at the prompt');
      assert.equal(
        (await session.eval('LiveModule.second')).output,
        '2',
        'and through the namespace, which is the same one it had',
      );
    });
  });

  test('a file the session never loaded is not run by refreshing it', async (assert) => {
    // Editing something is editing it. Running it would be a decision nobody made.
    await withRepl({}, async (session) => {
      assert.strictEqual(await session.refresh('lib/repl/session.ts'), null);
    });
  });

  test('a name asked for by hand survives the refresh', async (assert) => {
    await using directory = await tempDir('api-repl-refresh-named');
    const live = path.join(directory.path, 'live-module.ts');
    await fs.writeFile(live, 'export const first = 1;\n');

    await withRepl({}, async (session) => {
      await session.importFile(live, 'Mine');
      await fs.writeFile(live, 'export const first = 2;\n');

      assert.deepEqual(await session.refresh(live), ['Mine', 'first']);
      assert.equal((await session.eval('Mine.first')).output, '2', 'with the new value in it');
    });
  });
});
