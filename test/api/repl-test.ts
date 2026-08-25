import { module, test } from 'qunitx';
import { withRepl, captureStream } from './helpers.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import { outputDir } from '../helpers/temp-dir.ts';
import * as QUnitX from '../../lib/api/index.ts';
import { streamConsole } from '../../lib/console.ts';
import '../helpers/custom-asserts.ts';

const PRELOAD = 'test/fixtures/repl-helpers.ts';

module('API | repl | evaluating in the page', { concurrency: true }, () => {
  test('answers with the page’s own values, not Node’s', async (assert) => {
    await withRepl({}, async (session) => {
      assert.equal((await session.evaluate('1 + 1')).output, '2');
      assert.equal((await session.evaluate("'hi'")).output, "'hi'");
      assert.equal(
        (await session.evaluate('({ a: 1, b: [2, 3] })')).output,
        '{ a: 1, b: [ 2, 3 ] }',
      );
      assert.equal(
        (await session.evaluate('document.title')).output,
        "'qunitx repl'",
        'there is a real document — this is the whole point of evaluating in the browser',
      );
      assert.equal(
        (await session.evaluate("document.querySelector('#qunit-fixture')")).output,
        '<div id="qunit-fixture"></div>',
        'a DOM node renders as its markup',
      );
    });
  });

  test('does what only a browser can: fetch its own server, and keep the DOM it built', async (assert) => {
    await withRepl({}, async (session) => {
      assert.equal(
        (await session.evaluate("(await fetch('/tests.js')).status")).output,
        '200',
        'top-level await against the session’s own origin',
      );
      await session.evaluate(
        "document.body.appendChild(Object.assign(document.createElement('p'), { id: 'note' }))",
      );
      assert.equal(
        (await session.evaluate("document.querySelector('#note').tagName")).output,
        "'P'",
        'the page persists between inputs — it is one document, not one per evaluation',
      );
    });
  });

  test('bindings persist, including one declared with await', async (assert) => {
    await withRepl({}, async (session) => {
      await session.evaluate('let counter = 1');
      await session.evaluate('counter += 1');
      assert.equal((await session.evaluate('counter')).output, '2');
      assert.equal(
        (await session.evaluate('let counter = 99')).output,
        'undefined',
        'REPL mode allows redeclaration, exactly as a devtools console does',
      );

      await session.evaluate("const later = await Promise.resolve('settled')");
      assert.equal((await session.evaluate('later')).output, "'settled'");
    });
  });

  test('a promise reports its state rather than being silently awaited', async (assert) => {
    await withRepl({}, async (session) => {
      assert.equal(
        (await session.evaluate('Promise.resolve(5)')).output,
        'Promise { <fulfilled> 5 }',
      );
      assert.equal(
        (await session.evaluate('new Promise(() => {})')).output,
        'Promise { <pending> }',
      );
    });
  });
});

module('API | repl | inputs that are not values', { concurrency: true }, () => {
  test('an unfinished input is reported as incomplete, and completes on the next line', async (assert) => {
    await withRepl({}, async (session) => {
      const first = await session.evaluate('const shape = {');

      assert.true(first.incomplete, 'nothing ran');
      assert.equal(first.output, '', 'and nothing was printed');
      assert.equal((await session.evaluate('const shape = { a: 1 }\n')).output, 'undefined');
      assert.equal((await session.evaluate('shape')).output, '{ a: 1 }');
    });
  });

  test('a real syntax error is reported instead of waiting for more input', async (assert) => {
    await withRepl({}, async (session) => {
      const result = await session.evaluate('const x = ;');

      assert.false(result.incomplete);
      assert.true(result.failed);
      assert.includes(result.output, 'SyntaxError');
    });
  });

  test('a thrown error comes back with its stack', async (assert) => {
    await withRepl({}, async (session) => {
      const result = await session.evaluate('boom()');

      assert.true(result.failed);
      assert.includes(result.output, 'ReferenceError: boom is not defined');
    });
  });

  test('an empty input is a no-op rather than an evaluation', async (assert) => {
    await withRepl({}, async (session) => {
      const result = await session.evaluate('   ');

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
      const result = await session.evaluate("test('adds', (a) => a.equal(1 + 1, 2))");

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
      await session.evaluate("test('first', (a) => a.true(true))");
      const second = await session.evaluate("test('second', (a) => a.true(true))");
      const third = await session.evaluate(
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
      const result = await session.evaluate("test('breaks', (a) => a.equal(1, 2, 'nope'))");

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
        assert.deepEqual(session.loaded[0][1], ['GREETING', 'boom', 'double']);
        assert.equal((await session.evaluate('double(21)')).output, '42');
        assert.equal((await session.evaluate('GREETING')).output, "'hello from the preload'");
        assert.includes(output.text(), 'ok 1 preloaded test');
      },
    );
  });

  test('a stack from preloaded code maps back to its own source', async (assert) => {
    await withRepl({ inputs: [PRELOAD] }, async (session) => {
      const result = await session.evaluate('boom()');

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
      assert.equal((await session.evaluate('double(21)')).output, '42');
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
        (await session.evaluate('typeof double')).output,
        "'undefined'",
        'a bare `qunitx repl` does not drag the project’s test files in',
      );
      assert.equal((await session.evaluate('typeof test')).output, "'function'", 'qunitx still is');
    });
  });
});

module('API | repl | lifecycle', { concurrency: true }, () => {
  test('reload drops every binding and keeps the session usable', async (assert) => {
    await withRepl({}, async (session) => {
      await session.evaluate('globalThis.kept = 1');
      await session.reload();

      assert.equal((await session.evaluate('typeof kept')).output, "'undefined'");
      assert.equal((await session.evaluate('1 + 1')).output, '2', 'and the page still answers');
    });
  });

  test('a closed session answers rather than hanging', async (assert) => {
    const session = await QUnitX.repl({ output: 'tmp/repl-closed' });
    await session.close();
    await session.close(); // idempotent

    const result = await session.evaluate('1 + 1');
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

      const result = await session.evaluate('inspectMe()');

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
      await session.evaluate('inspectMe()');

      assert.strictEqual((await session.evaluate('answer')).output, '42');
      assert.strictEqual((await session.evaluate('answer * 2')).output, '84');
      await session.resume();
    });
  });

  test('what you declare while stopped lasts as long as the breakpoint', async (assert) => {
    // `Debugger.evaluateOnCallFrame` runs each input in a scope of its own and throws it away, so
    // a `let` there used to answer `undefined` and then not exist — which looks like it worked.
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      await session.evaluate('inspectMe()');

      assert.strictEqual((await session.evaluate('let me = { age: 32 }')).output, 'undefined');
      assert.strictEqual((await session.evaluate('me.age')).output, '32', 'it is still there');

      const doubled = await session.evaluate('const doubled = answer * 2');
      assert.strictEqual(doubled.output, 'undefined');
      assert.strictEqual(
        (await session.evaluate('doubled')).output,
        '84',
        'and its initializer saw the frame, which is the whole point of declaring it here',
      );
      await session.resume();
    });
  });

  test('what the block owns goes when the breakpoint does', async (assert) => {
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      await session.evaluate('inspectMe()');
      await session.evaluate('let me = { age: 32 }');

      await session.resume();

      assert.true((await session.evaluate('me')).failed, 'the session that carries on has no `me`');
      assert.strictEqual(
        (await session.evaluate('let me = "mine"')).output,
        'undefined',
        'and the name is free for it to declare its own',
      );
      assert.strictEqual((await session.evaluate('me')).output, "'mine'");
    });
  });

  test('what JavaScript hoists out of a block is still there afterwards', async (assert) => {
    // `var` and `function` are not block-scoped anywhere else, and a prompt where they vanished
    // would be a prompt with its own rules.
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      await session.evaluate('inspectMe()');
      await session.evaluate('var kept = "sticky"');
      await session.evaluate('function greet() { return "hi" }');
      await session.evaluate('const gone = 1');

      await session.resume();

      assert.strictEqual((await session.evaluate('kept')).output, "'sticky'", 'var stays');
      assert.strictEqual(
        (await session.evaluate('greet()')).output,
        "'hi'",
        'and so does function',
      );
      assert.true((await session.evaluate('gone')).failed, 'where const went with its block');
    });
  });

  test('a declaration at a breakpoint shadows one of the same name outside it', async (assert) => {
    // The reason a binding cannot simply be written to `globalThis`: a top-level `let` is a global
    // LEXICAL binding, and one of those wins over a property of the same name. The inner one has
    // to arrive as something that shadows it.
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      await session.evaluate('let me = { age: 32 }');
      await session.evaluate('inspectMe()');

      assert.strictEqual(
        (await session.evaluate('me')).output,
        '{ age: 32 }',
        'the outer one, until something says otherwise',
      );

      await session.evaluate('let me = { age: 33 }');

      assert.strictEqual((await session.evaluate('me')).output, '{ age: 33 }', 'and now the inner');

      await session.resume();

      assert.strictEqual(
        (await session.evaluate('me')).output,
        '{ age: 32 }',
        'and the outer one is untouched by any of it',
      );
    });
  });

  test('what was declared at the breakpoint can be assigned to there', async (assert) => {
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      await session.evaluate('inspectMe()');
      await session.evaluate('let count = 1');
      await session.evaluate('count = count + 1');

      assert.strictEqual((await session.evaluate('count')).output, '2', 'the assignment stuck');
      await session.resume();
    });
  });

  test('resuming lets it carry on, and the session is a session again', async (assert) => {
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      await session.evaluate('inspectMe()');
      assert.ok(session.pausedAt, 'paused');

      await session.resume();

      assert.strictEqual(session.pausedAt, null, 'and running again');
      assert.strictEqual((await session.evaluate('6 * 7')).output, '42');
    });
  });

  test('the frame comes with the source it stopped in', async (assert) => {
    // The ORIGINAL source, not the bundle the page actually ran — the line number has to point at
    // something a person can read.
    await withRepl({ inputs: [DEBUGGED] }, async (session) => {
      assert.strictEqual(await session.frameSource(), null, 'nothing is stopped yet');

      await session.evaluate('inspectMe()');
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
      await session.evaluate('function typed() { debugger; return 1 }');
      await session.evaluate('typed()');

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
      assert.strictEqual((await session.evaluate('1 + 1')).output, '2', 'still usable');
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
      await session.evaluate('const label = "one"');
      await session.evaluate('globalThis.total = 42');

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
      await session.evaluate('globalThis.calls = 0');
      await session.evaluate('globalThis.sideEffect = () => { calls += 1; return document }');

      assert.deepEqual(await session.names('sideEffect()'), [], 'not a path, so not evaluated');
      assert.strictEqual(
        (await session.evaluate('calls')).output,
        '0',
        'and the page is untouched — a keystroke is not consent to call your function',
      );
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

      await session.evaluate('const label = "one"');
      await session.evaluate('globalThis.total = 42');
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

      await session.evaluate('inspectMe()');
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
      await session.evaluate('const label = "one"');
      await session.evaluate('inspectMe()');

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
        (await session.evaluate('typeof globalThis.zap')).output,
        "'undefined'",
        'none of it happened',
      );
      assert.strictEqual(
        (await session.evaluate('document.querySelectorAll("p").length')).output,
        '0',
        'and the page is as it was',
      );
    });
  });

  test('what cannot be answered quickly is not answered', async (assert) => {
    await withRepl({}, async (session) => {
      assert.strictEqual(await session.preview('for (;;) {}'), '', 'a loop that never ends');
      assert.strictEqual(await session.preview('nope.nope'), '', 'and one that throws');
      assert.strictEqual((await session.evaluate('1 + 1')).output, '2', 'the session carries on');
    });
  });

  test('a stopped page is not asked, because a stopped page does not answer', async (assert) => {
    await withRepl({ inputs: ['test/fixtures/repl-debugger.ts'] }, async (session) => {
      await session.evaluate('inspectMe()');

      assert.strictEqual(await session.preview('1 + 1'), '', 'and the prompt keeps taking keys');
      await session.resume();
    });
  });
});
