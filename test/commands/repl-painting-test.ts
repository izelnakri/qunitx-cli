import { EventEmitter } from 'node:events';
import { module, test } from 'qunitx';
import { setupHighlighting } from '../../lib/commands/repl/index.ts';
import { theme } from '../../lib/repl/theme.ts';
import '../helpers/custom-asserts.ts';

const ESC = String.fromCharCode(27);

// readline decides WHERE everything goes and this only decides what it looks like, which is the
// whole reason the substitution is by value: anything that is not exactly the line readline
// believes it is drawing passes through untouched, so no cursor arithmetic can go wrong.
module('Commands | repl | painting', { concurrency: true }, () => {
  /** A REPLServer with the internals painting reaches for, and a record of what reached output. */
  function fakeServer(prompt = '> ') {
    const input = new EventEmitter();
    const written: string[] = [];
    const server = {
      line: '',
      input,
      getPrompt: () => prompt,
      refreshed: 0,
      _writeToOutput: (text: string) => void written.push(text),
      _refreshLine: () => void (server.refreshed += 1),
    };
    // Forced on: the test runner's stdout is a pipe, where a real session paints nothing.
    setupHighlighting(server as unknown as Parameters<typeof setupHighlighting>[0], theme(true));

    return { server, written, input };
  }

  test('the line readline is drawing comes out painted', (assert) => {
    const { server, written } = fakeServer();
    server.line = "const a = 'one'";

    server._writeToOutput(`> ${server.line}`);

    assert.includes(written[0] ?? '', `${ESC}[31mconst${ESC}[0m`, 'the keyword');
    assert.includes(written[0] ?? '', `${ESC}[33m'one'${ESC}[0m`, 'and the string');
    assert.true(written[0]?.startsWith('> '), 'the prompt is left exactly as it was');
  });

  test('anything else readline writes is written as readline wrote it', (assert) => {
    // The single character an append writes, the space that forces a new row, a continuation
    // row — none of them are the line, and painting a fragment would paint it wrong.
    const { server, written } = fakeServer();
    server.line = "const a = 'one'";

    server._writeToOutput('t');
    server._writeToOutput(' ');
    server._writeToOutput(`> const a = 'one' and more`);

    assert.deepEqual(written, ['t', ' ', "> const a = 'one' and more"]);
  });

  test('an empty line is not painted, and neither is the prompt alone', (assert) => {
    const { server, written } = fakeServer();

    server._writeToOutput('> ');

    assert.deepEqual(written, ['> ']);
  });

  test('painting changes what is drawn, never how wide it is', (assert) => {
    // What keeps readline's cursor arithmetic correct: it computed every position from the plain
    // line, so the painted one has to occupy exactly the same columns.
    const { server, written } = fakeServer();
    server.line = "test('adds', (a) => a.equal(1 + 1, 2))";

    server._writeToOutput(`> ${server.line}`);

    const stripped = (written[0] ?? '')
      .split(ESC)
      .map((part, index) => (index === 0 ? part : part.slice(part.indexOf('m') + 1)))
      .join('');

    assert.strictEqual(stripped, `> ${server.line}`, 'the same characters, in the same columns');
  });

  test('a keypress asks for a refresh, and a burst of them asks once', async (assert) => {
    // readline appends a typed character in place rather than redrawing, so a keyword cannot be
    // recognised one character at a time — but a paste is one chunk of a hundred keypresses, and
    // repainting the line a hundred times is a hundred times the output.
    const { server, input } = fakeServer();
    server.line = 'const';

    for (const character of 'const') input.emit('keypress', character);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.strictEqual(server.refreshed, 1, 'one repaint for the whole burst');

    input.emit('keypress', 'x');
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.strictEqual(server.refreshed, 2, 'and the next tick repaints again');
  });

  test('an emptied line is not repainted, so an answer keeps its own line', async (assert) => {
    // The keypress that empties the line is Enter, which submits it — and the prompt a repaint
    // would draw then belongs to the input just SENT, so it landed in front of the answer:
    // `| undefined` for a block that had just finished. Deleting back to empty is readline's own
    // redraw, so nothing is lost by leaving that to it.
    const { server, input } = fakeServer();
    server.line = 'function a() {}';
    input.emit('keypress', 'x');
    await new Promise<void>((resolve) => setImmediate(resolve));

    server.line = '';
    input.emit('keypress', String.fromCharCode(13));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.strictEqual(server.refreshed, 1, 'the submitted line is not drawn again');
  });
});
