import nodeRepl from 'node:repl';
import { PassThrough } from 'node:stream';
import { module, test } from 'qunitx';
import { isTerminalsOwn, keysOf, withVimMode } from '../../../lib/commands/repl/vim-mode.ts';
import '../../helpers/custom-asserts.ts';

import type { REPLServer } from 'node:repl';

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);

/** How long a keystroke is given to reach readline before the test calls it a failure. */
const WAIT_MS = 10_000;

// A real `node:repl` over a fake TTY, which is the only way to show the part that matters: that
// normal mode edits the line READLINE holds, rather than a copy of it that drifts.

module('Commands | repl | vim mode | reading keys', { concurrency: true }, () => {
  test('a chunk becomes keys, an escape sequence counting as one', (assert) => {
    assert.deepEqual(keysOf('abc'), ['a', 'b', 'c']);
    assert.strictEqual(keysOf(`${ESC}[A`).length, 1, 'an arrow is one key');
    assert.strictEqual(keysOf(`${ESC}OP`).length, 1, 'and so is an SS3 function key');
    assert.strictEqual(keysOf('').length, 0);
  });

  test('Escape then a letter is two keys, not Alt-letter', (assert) => {
    // Terminals send both as `ESC W`, and at a vim prompt the first is what happened — leaving
    // insert mode and giving a command is one gesture, so the two arrive inside one read.
    assert.deepEqual(keysOf(`${ESC}w`), [ESC, 'w']);
    assert.deepEqual(keysOf(`${ESC}dd`), [ESC, 'd', 'd']);
  });

  test('a code point is one key, however many bytes it took', (assert) => {
    assert.strictEqual(keysOf('a\u{1F389}b').length, 3);
  });

  test('what the terminal keeps: sequences and control keys, never Enter', (assert) => {
    assert.true(isTerminalsOwn(`${ESC}[A`), 'an arrow');
    assert.true(isTerminalsOwn(CTRL_C), 'Ctrl-C still interrupts');
    assert.true(isTerminalsOwn('\t'), 'TAB still completes');
    assert.false(isTerminalsOwn('w'), 'a motion is the grammar’s');
    assert.false(isTerminalsOwn('\r'), 'and so is Enter, which drops a half-typed command');
    assert.false(isTerminalsOwn(ESC));
  });
});

module('Commands | repl | vim mode | driving a real prompt', { concurrency: true }, () => {
  test('typing reaches readline exactly as it did before', async (assert) => {
    await using prompt = replOverVim();
    prompt.type('1 + 1');
    await prompt.until(() => prompt.server.line === '1 + 1', 'the line to arrive');

    assert.strictEqual(prompt.server.line, '1 + 1');
    assert.strictEqual(prompt.vim.mode, 'insert');
  });

  test('Escape leaves insert and puts the caret on the last character', async (assert) => {
    await using prompt = replOverVim();
    prompt.type('1 + 1');
    await prompt.until(() => prompt.server.line === '1 + 1', 'the line');
    prompt.type(ESC);
    await prompt.until(() => prompt.vim.mode === 'normal', 'normal mode');

    assert.strictEqual(prompt.server.cursor, 4, 'was 5, now on the final 1');
  });

  test('x edits the line readline holds, which is the whole point', async (assert) => {
    await using prompt = replOverVim();
    prompt.type(`1 + 1${ESC}x`);
    await prompt.until(() => prompt.server.line === '1 + ', 'the delete to land');

    assert.strictEqual(prompt.server.line, '1 + ');
    assert.strictEqual(prompt.server.cursor, 3, 'clamped back onto a character');
  });

  test('dd clears the line rather than typing two d’s into it', async (assert) => {
    await using prompt = replOverVim();
    // The line has to be THERE before "it is empty" means anything — an empty line is the state
    // this starts in, so waiting for one would wait for nothing.
    prompt.type('boom()');
    await prompt.until(() => prompt.server.line === 'boom()', 'the line');
    prompt.type(`${ESC}dd`);
    await prompt.until(() => prompt.server.line === '', 'the line to be emptied');

    assert.strictEqual(prompt.server.line, '');
  });

  test('a normal-mode letter is never typed', async (assert) => {
    await using prompt = replOverVim();
    prompt.type(`1 + 1${ESC}hhhh`);
    await prompt.until(() => prompt.server.cursor === 0, 'the caret to walk to the start');

    assert.strictEqual(prompt.server.line, '1 + 1', 'not a single h reached the line');
  });

  test('i goes back to insert, and typing works again', async (assert) => {
    await using prompt = replOverVim();
    prompt.type(`1 + ${ESC}0i`);
    await prompt.until(() => prompt.vim.mode === 'insert', 'insert mode');
    prompt.type('2');
    await prompt.until(() => prompt.server.line === '21 + ', 'the insert at the start');

    assert.strictEqual(prompt.server.line, '21 + ');
  });

  test('a text object reaches inside the quotes, on the real line', async (assert) => {
    await using prompt = replOverVim();
    prompt.type(`const a = "old"${ESC}ci"`);
    await prompt.until(() => prompt.server.line === 'const a = ""', 'the change');
    prompt.type('new');
    await prompt.until(() => prompt.server.line === 'const a = "new"', 'the typing after it');

    assert.strictEqual(prompt.server.line, 'const a = "new"');
  });

  test('an arrow still moves the caret in normal mode', async (assert) => {
    await using prompt = replOverVim();
    prompt.type(`1 + 1${ESC}`);
    await prompt.until(() => prompt.vim.mode === 'normal', 'normal mode');
    prompt.type(`${ESC}[D`);
    await prompt.until(() => prompt.server.cursor === 3, 'readline to answer the arrow');

    assert.strictEqual(prompt.server.line, '1 + 1', 'and nothing was typed');
  });

  test('u takes back what the last command did', async (assert) => {
    await using prompt = replOverVim();
    // Escape puts the caret on the LAST character, so `x` takes the `d` — which is vim, and worth
    // spelling out because the obvious guess is that it takes the first one.
    prompt.type(`abcd${ESC}x`);
    await prompt.until(() => prompt.server.line === 'abc', 'the delete under the caret');
    prompt.type('u');
    await prompt.until(() => prompt.server.line === 'abcd', 'the undo');

    assert.strictEqual(prompt.server.line, 'abcd');
  });

  test('the caret changes shape on the way in and out of normal mode', async (assert) => {
    await using prompt = replOverVim();
    prompt.type(`a${ESC}`);
    await prompt.until(() => prompt.vim.mode === 'normal', 'normal mode');

    assert.includes(prompt.written(), `${ESC}[2 q`, 'a block for normal');
    prompt.type('i');
    await prompt.until(() => prompt.vim.mode === 'insert', 'insert mode');
    assert.includes(prompt.written(), `${ESC}[6 q`, 'and a bar for insert');
  });

  test('a key waits for readline, even while its input is paused', async (assert) => {
    // The bug this exists for, and the one only a real session found: the REPL keeps its input
    // PAUSED between lines, so a forwarded byte lands in the stream's buffer and `server.line`
    // still reads `''` however many ticks later. Waiting a tick and then acting deleted a
    // character out of an empty string and lost the keystroke.
    await using prompt = replOverVim();
    prompt.pause();
    prompt.type(`1 + 1${ESC}x`);
    for (let round = 0; round < 20; round++) await new Promise((r) => setImmediate(r));

    assert.strictEqual(prompt.server.line, '', 'nothing has reached readline yet');
    prompt.resume();
    await prompt.until(() => prompt.server.line === '1 + ', 'the delete, once it could land');

    assert.strictEqual(prompt.server.line, '1 + ', 'the keystroke was held, not lost');
  });

  test('before it is attached, every byte passes straight through', async (assert) => {
    // Which is what leaves a piped session — and the moment before the server exists — alone.
    const stdin = fakeTTY();
    const vim = withVimMode(stdin as unknown as NodeJS.ReadStream);
    const seen: string[] = [];
    vim.stream.on('data', (chunk: Buffer) => void seen.push(chunk.toString()));
    stdin.write(`a${ESC}x`);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(
      seen.join(''),
      `a${ESC}x`,
      'including the keys normal mode would have taken',
    );
  });
});

/** A `PassThrough` readline will believe is a terminal. */
function fakeTTY() {
  return Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
}

/**
 * A real `node:repl` reading through vim mode, with the fake terminal on both ends.
 *
 * `until` rather than a fixed number of ticks: the handler waits for readline to have consumed
 * what it forwarded, so how many turns of the loop a key takes is not something a test should be
 * asserting about. Bounded, so a mistake fails rather than hangs.
 */
function replOverVim() {
  const stdin = fakeTTY();
  const vim = withVimMode(stdin as unknown as NodeJS.ReadStream);
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (chunk: Buffer) => void chunks.push(chunk.toString()));

  const server: REPLServer = nodeRepl.start({
    input: vim.stream,
    output,
    terminal: true,
    prompt: '> ',
    // Nothing here evaluates anything: every test reads the LINE, and an eval that answered would
    // only add output to sift through.
    eval: (_source, _context, _file, callback) => void callback(null, undefined),
  });
  vim.attach(server);

  return {
    server,
    vim,
    type: (keys: string) => void stdin.write(keys),
    // The REPL's own between-lines pause, reproduced — see the test that uses it.
    pause: () => void vim.stream.pause(),
    resume: () => void vim.stream.resume(),
    written: () => chunks.join(''),
    async until(check: () => boolean, what: string) {
      // Bounded by TIME, not by a number of ticks. 500 `setImmediate` rounds is a count, and on a
      // loaded CI runner all 500 can elapse in a couple of milliseconds of wall clock while the
      // stream event this is waiting for has not been serviced yet — a flake by construction.
      // `setTimeout` also lets the loop reach the poll phase, which is where that event arrives.
      const deadline = Date.now() + WAIT_MS;
      while (!check()) {
        if (Date.now() > deadline) {
          throw new Error(`vim mode never got to ${what} — line is ${JSON.stringify(server.line)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    },
    [Symbol.dispose]() {
      server.close();
    },
  };
}
