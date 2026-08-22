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
