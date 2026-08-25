import { EventEmitter } from 'node:events';
import { module, test } from 'qunitx';
import { setupPreview } from '../../lib/commands/repl/index.ts';
import '../helpers/custom-asserts.ts';

const ESC = String.fromCharCode(27);

// The answer to `1 + 1` is not worth a round of the read-eval-print loop, so it is offered before
// Enter — but only where there is room for it, and never at the cost of the line it belongs to.
module('Commands | repl | preview', { concurrency: true }, () => {
  /** A REPLServer and a session that answers whatever it was told to, when asked. */
  function fakeServer(
    options: {
      columns?: number;
      answer?: string;
      busy?: boolean;
      hold?: boolean;
      reserved?: string;
    } = {},
  ) {
    const input = new EventEmitter();
    const drawn: string[] = [];
    const asked: string[] = [];
    const pending: Array<(value: string) => void> = [];
    const server = {
      line: '',
      cursor: 0,
      input,
      getPrompt: () => '> ',
      output: { columns: options.columns ?? 100, write: (text: string) => void drawn.push(text) },
    };
    const session = {
      preview: (line: string) => {
        asked.push(line);
        // Held open on request, so a test can let the typing carry on while the page is answering.
        return options.hold
          ? new Promise<string>((resolve) => void pending.push(resolve))
          : Promise.resolve(options.answer ?? '');
      },
    };
    setupPreview(
      server as unknown as Parameters<typeof setupPreview>[0],
      session as unknown as Parameters<typeof setupPreview>[1],
      () => options.busy ?? false,
      () => options.reserved ?? '',
    );

    /** A keystroke, and the wait the debounce asks for. */
    const type = async (line: string) => {
      server.line = line;
      server.cursor = line.length;
      input.emit('keypress', 'x');
      await new Promise((resolve) => setTimeout(resolve, 140));
    };

    /** Answers the request the page is still holding, and lets the draw happen. */
    const answer = async (value: string) => {
      pending.shift()?.(value);
      await new Promise((resolve) => setImmediate(resolve));
    };

    return { server, drawn, asked, type, answer };
  }

  test('the answer is drawn against the right margin, and the cursor put back', async (assert) => {
    const { drawn, type } = fakeServer({ answer: "'qunitx repl'" });

    await type('document.title');

    // 100 columns, a 13-column answer: it starts at 88 and ends on the last one.
    assert.strictEqual(drawn[0], `${ESC}[88G'qunitx repl'${ESC}[0m${ESC}[17G`);
  });

  test('the page is asked once for a burst of typing', async (assert) => {
    const { server, asked, type } = fakeServer({ answer: '2' });

    server.line = '1 +';
    for (const character of '1 + 1') server.input.emit('keypress', character);
    await type('1 + 1');

    assert.deepEqual(asked, ['1 + 1'], 'every request is a round trip, and only the last matters');
  });

  test('a terminal too narrow to share is left alone', async (assert) => {
    const { drawn, asked, type } = fakeServer({ columns: 40, answer: '2' });

    await type('1 + 1');

    assert.deepEqual(asked, [], 'and it is not even asked — the answer could not be drawn');
    assert.deepEqual(drawn, []);
  });

  test('a line already at the margin keeps its columns', async (assert) => {
    const { drawn, asked, type } = fakeServer({ columns: 100, answer: '2' });

    await type('x'.repeat(95));

    assert.deepEqual(asked, [], 'the line has the terminal, and the preview does not fight it');
    assert.deepEqual(drawn, []);
  });

  test('what is not an expression is not previewed', async (assert) => {
    const { asked, type } = fakeServer({ answer: '2' });

    await type('.scope');
    await type(':git status');
    await type('   ');

    assert.deepEqual(asked, [], 'a command, a shell line, and nothing at all');
  });

  test('nothing is asked while the session is answering something else', async (assert) => {
    const { asked, type } = fakeServer({ answer: '2', busy: true });

    await type('1 + 1');

    assert.deepEqual(asked, []);
  });

  test('an answer worth nothing is not drawn', async (assert) => {
    for (const answer of ['', 'undefined']) {
      const { drawn, type } = fakeServer({ answer });
      await type('whatever');

      assert.deepEqual(drawn, [], `${answer || 'an empty answer'} says nothing`);
    }
  });

  test('being told what you just typed is not information', async (assert) => {
    const { drawn, type } = fakeServer({ answer: '42' });

    await type('42');

    assert.deepEqual(drawn, []);
  });

  test('an answer to a line that has moved on is thrown away', async (assert) => {
    // The page takes a moment, and in that moment the typing continues. Drawing then would put
    // the answer to one line beside a different one.
    const { server, drawn, type, answer } = fakeServer({ hold: true });

    await type('document.title');
    server.line = 'document.titl';
    await answer("'qunitx repl'");

    assert.deepEqual(drawn, [], 'the answer to one line is not drawn beside a different one');
  });

  test('the colours the page rendered it in are the colours it is drawn in', async (assert) => {
    // A keystroke later the same value is printed by the same renderer. Repainting it in one
    // colour here would make the preview a different kind of thing from the answer it previews.
    const { drawn, type } = fakeServer({ answer: `${ESC}[33m'one'${ESC}[39m` });

    await type('label');

    assert.includes(drawn[0] ?? '', `${ESC}[33m'one'${ESC}[39m`);
  });

  test('a value rendered over several lines is drawn on one', async (assert) => {
    // `window.self` comes back as a page of an object graph. A value that shares a row with what
    // is being typed cannot bring its own rows with it — the newlines land in the middle of the
    // prompt and take the layout apart.
    const { drawn, type } = fakeServer({ answer: 'Window {\n  self: [Circular],\n  a: 1\n}' });

    await type('window.self');

    assert.notIncludes(drawn[0] ?? '', '\n', 'no newline reaches the terminal');
    assert.includes(drawn[0] ?? '', 'Window { self: [Circular], a: 1 }', 'folded onto one line');
  });

  test('the suggestion on the same row is counted as room already taken', async (assert) => {
    // The ghost is drawn after the cursor on this row. A preview that ignores it lands on top of
    // the tail of what it is offering.
    const wide = fakeServer({ columns: 100, answer: '2', reserved: '' });
    const crowded = fakeServer({ columns: 100, answer: '2', reserved: 'x'.repeat(90) });

    await wide.type('1 + 1');
    await crowded.type('1 + 1');

    assert.strictEqual(wide.drawn.length, 1, 'room enough on its own');
    assert.deepEqual(crowded.drawn, [], 'and none once the suggestion has taken it');
  });

  test('an answer too wide for the room is cut to it', async (assert) => {
    const { drawn, type } = fakeServer({ columns: 60, answer: 'x'.repeat(200) });

    await type('someValue');

    assert.true((drawn[0] ?? '').includes('…'), 'and says that it was');
    // 60 columns, less the prompt, the nine typed and the gap: 47 are left, and it fills them.
    assert.true((drawn[0] ?? '').includes(`${ESC}[14G`), 'filling the room the line left it');
  });
});
