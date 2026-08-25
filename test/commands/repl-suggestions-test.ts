import { EventEmitter } from 'node:events';
import { module, test } from 'qunitx';
import { setupSuggestions } from '../../lib/commands/repl.ts';
import '../helpers/custom-asserts.ts';

// The two ways a ghost goes wrong are both about REMEMBERING it. On screen, readline appends a
// typed character in place instead of redrawing, so a suggestion that shrinks leaves its tail
// behind. In the accept path, a ghost held in a variable outlives the line it was computed for —
// `.nvim` reads no keys for as long as the editor is open — and Ctrl-F then inserts the tail of a
// line nobody is typing.
module('Commands | repl | suggestions', { concurrency: true }, () => {
  const ESC = String.fromCharCode(27);
  const CTRL_F = String.fromCharCode(6);
  const CLEAR = `${ESC}[0J`;

  /** A REPLServer with only the parts a suggestion touches, and a record of what it drew. */
  function fakeServer(history: string[]) {
    const input = new EventEmitter();
    const drawn: string[] = [];
    const server = {
      line: '',
      cursor: 0,
      history,
      input,
      output: { write: (text: string) => void drawn.push(text) },
      _writeToOutput: (text: string) => void drawn.push(text),
      // What readline's own `write` does to the line, which is all this needs to observe.
      write(text: string) {
        server.line += text;
        server.cursor = server.line.length;
      },
    };
    setupSuggestions(server as unknown as Parameters<typeof setupSuggestions>[0]);

    /** One keystroke: the line as readline would have left it, then the key that left it there. */
    const press = (key: string, line?: string) => {
      if (line !== undefined) {
        server.line = line;
        server.cursor = line.length;
      }
      input.emit('keypress', key);

      // The draw is scheduled for after readline has finished with this same keypress.
      return new Promise<void>((resolve) => setImmediate(resolve));
    };

    return { server, drawn, press };
  }

  test('a suggestion that shrinks erases the one it replaces', async (assert) => {
    // `dz…` is newest, so `d` matches it and `do` cannot — the second suggestion is far shorter
    // than the first, and every character of the difference is still on screen.
    const { drawn, press } = fakeServer(['dzz_LEFTOVER_TAIL', 'document.title']);

    await press('d', 'd');
    await press('o', 'do');

    assert.true(drawn.length >= 2, 'it drew for both keystrokes');
    assert.true(
      drawn.every((chunk) => chunk.startsWith(CLEAR)),
      'each draw clears first',
    );
    assert.includes(drawn.at(-1) ?? '', 'cument.title', 'and then offers the shorter one');
  });

  test('nothing is drawn — or erased — from the middle of a line', async (assert) => {
    const { server, drawn, press } = fakeServer(['document.title']);

    await press('d', 'd');
    drawn.length = 0;
    server.cursor = 0;
    await press(`${ESC}[D`);

    assert.deepEqual(drawn, [], 'the text after the cursor is the line, not a suggestion');
  });

  test('submitting the line takes the suggestion off the screen with it', async (assert) => {
    // readline moves the cursor to the end of the line and writes a newline, leaving that row
    // behind for good. The suggestion is drawn exactly there, and every other erase happens by
    // redrawing the line — which this row never is. `me` submitted under a suggestion of
    // `menubar` was echoed back as `menubar`.
    const { server, drawn, press } = fakeServer(['menubar']);

    await press('m', 'me');
    drawn.length = 0;
    (server as unknown as { _writeToOutput(text: string): void })._writeToOutput('\r\n');

    assert.deepEqual(drawn, [`${CLEAR}\r\n`], 'cleared where the cursor is, then the newline');
  });

  test('anything else readline writes on its way is untouched', async (assert) => {
    const { server, drawn, press } = fakeServer(['menubar']);

    await press('m', 'me');
    drawn.length = 0;
    (server as unknown as { _writeToOutput(text: string): void })._writeToOutput('> me');

    assert.deepEqual(drawn, ['> me'], 'only the newline means the row is being left behind');
  });

  test('Ctrl-F takes the suggestion for the line as it stands', async (assert) => {
    const { server, press } = fakeServer(['document.title']);

    await press('d', 'd');
    await press(CTRL_F);

    assert.strictEqual(server.line, 'document.title');
  });

  test('Ctrl-F takes nothing when the line moved on without a keystroke', async (assert) => {
    // What `.nvim` does: the editor owns the terminal, no key reaches the REPL while it is open,
    // and the line is empty again on the way out. A ghost computed before it is not an offer.
    const { server, press } = fakeServer(['document.title']);

    await press('d', 'd');
    server.line = '';
    server.cursor = 0;
    await press(CTRL_F);

    assert.strictEqual(server.line, '', 'an empty line suggests nothing, so nothing is inserted');
  });
});
