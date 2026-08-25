import { EventEmitter } from 'node:events';
import { module, test } from 'qunitx';
import { complete, setupSuggestions } from '../../lib/commands/repl.ts';
import '../helpers/custom-asserts.ts';

const ESC = String.fromCharCode(27);
const CTRL_F = String.fromCharCode(6);
const CLEAR = `${ESC}[0J`;

// The two ways a ghost goes wrong are both about REMEMBERING it. On screen, readline appends a
// typed character in place instead of redrawing, so a suggestion that shrinks leaves its tail
// behind. In the accept path, a ghost held in a variable outlives the line it was computed for —
// `.nvim` reads no keys for as long as the editor is open — and Ctrl-F then inserts the tail of a
// line nobody is typing.
module('Commands | repl | suggestions', { concurrency: true }, () => {
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

// One source of names behind both TAB and the ghost. TAB waits for the page's answer, where a
// moment is affordable; the ghost draws what is known and redraws when a late answer lands.
module('Commands | repl | completion', { concurrency: true }, () => {
  test('TAB lists what the page has on the path', async (assert) => {
    const { source } = stubNames({ document: ['title', 'querySelector', 'body'] });

    assert.deepEqual(await hits({}, source, 'document.'), ['body', 'querySelector', 'title']);
    assert.deepEqual(await hits({}, source, 'document.qu'), ['querySelector'], 'filtered by token');
  });

  test('TAB completes the dot commands, which no page knows about', async (assert) => {
    const server = { commands: { reload: {}, resume: {}, exit: {} } };

    assert.deepEqual(await hits(server, stubNames({}).source, '.re'), ['.reload', '.resume']);
  });

  test('TAB offers nothing it would have to run something to answer', async (assert) => {
    const { source } = stubNames({ '': ['foo'] });

    assert.deepEqual(await hits({}, source, 'foo().b'), [], 'calling foo() is not what TAB means');
  });

  test('a name that arrives late is drawn on the line that asked for it', async (assert) => {
    // The page is another process and the first keystroke cannot wait for it. What is known is
    // drawn now — nothing, here — and the answer redraws itself when it lands.
    const { source, deliver } = stubNames({ '': ['inspectMe'] });
    const { drawn, press } = fakeServer([], source);

    await press('i', 'inspec');

    assert.false(
      drawn.some((chunk) => chunk.includes('tMe')),
      'nothing to offer yet, and nothing invented',
    );

    deliver('');

    assert.true(
      drawn.some((chunk) => chunk.includes('tMe')),
      'and once the page has answered, the line that was typed gets its suggestion',
    );
  });
});

/** A REPLServer with only the parts a suggestion touches, and a record of what it drew. */
function fakeServer(history: string[], names?: unknown) {
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
  setupSuggestions(
    server as unknown as Parameters<typeof setupSuggestions>[0],
    names as Parameters<typeof setupSuggestions>[1],
  );

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

/** A NameSource whose answers are handed over on demand, so lateness can be tested. */
function stubNames(names: Record<string, string[]>) {
  const listeners: Array<() => void> = [];
  const delivered = new Set<string>();

  return {
    source: {
      lookup: (base: string) => (delivered.has(base) ? (names[base] ?? []) : []),
      ask: (base: string) => Promise.resolve(names[base] ?? []),
      stale: () => {},
      subscribe: (listener: () => void) => void listeners.push(listener),
    },
    /** What a fetch resolving looks like: the answer becomes known, and subscribers redraw. */
    deliver(base: string) {
      delivered.add(base);
      for (const listener of listeners) listener();
    },
  };
}

/** What TAB would have listed for `line`. */
function hits(server: unknown, source: unknown, line: string): Promise<string[]> {
  return new Promise((resolve) => {
    complete(
      server as Parameters<typeof complete>[0],
      source as Parameters<typeof complete>[1],
      line,
      (_error, [found]) => resolve(found),
    );
  });
}
