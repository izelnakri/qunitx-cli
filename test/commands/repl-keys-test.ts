import { PassThrough } from 'node:stream';
import { module, test } from 'qunitx';
import { vimKeys } from '../../lib/commands/repl.ts';
import '../helpers/custom-asserts.ts';

// Ctrl-K and Ctrl-J are rewritten before readline sees them, because neither can be handled after.
// Ctrl-K already means kill-to-end-of-line, and a second listener runs as well as readline's rather
// than instead of it. Ctrl-J is not a distinguishable key at all — it arrives as `\n`, the same
// byte readline reads as Enter and the same byte every multi-line paste is full of.
module('Commands | repl | vim history keys', { concurrency: true }, () => {
  const ARROW_UP = '\u001b[A';
  const ARROW_DOWN = '\u001b[B';

  /** Feeds chunks through the translator and resolves with everything readline would have seen. */
  function translate(...chunks: Array<Buffer | string>): Promise<string> {
    const stdin = new PassThrough();
    (stdin as unknown as { setRawMode: (mode: boolean) => void }).setRawMode = () => {};
    const out = vimKeys(stdin as unknown as NodeJS.ReadStream);
    const seen: Buffer[] = [];
    out.on('data', (chunk: Buffer) => seen.push(Buffer.from(chunk)));

    return new Promise((resolve) => {
      out.on('end', () => resolve(Buffer.concat(seen).toString('utf8')));
      for (const chunk of chunks) stdin.write(chunk);
      stdin.end();
    });
  }

  test('a lone Ctrl-K becomes the up arrow readline walks history with', async (assert) => {
    assert.strictEqual(await translate(Buffer.from([0x0b])), ARROW_UP);
  });

  test('a lone Ctrl-J becomes the down arrow', async (assert) => {
    assert.strictEqual(await translate(Buffer.from([0x0a])), ARROW_DOWN);
  });

  test('a pasted newline is left alone, so the paste still submits its lines', async (assert) => {
    // The whole reason this is a byte test and not a key binding: a `\n` with company is a paste,
    // and rewriting it would stop every pasted line from running.
    assert.strictEqual(await translate('1 + 1\n2 + 2\n'), '1 + 1\n2 + 2\n');
  });

  test('a Ctrl-K inside a larger chunk is also a paste, and untouched', async (assert) => {
    assert.strictEqual(await translate(Buffer.from([0x61, 0x0b, 0x62])), 'a\u000bb');
  });

  test('ordinary keystrokes pass through unchanged', async (assert) => {
    assert.strictEqual(await translate('a', 'b', '\r'), 'ab\r');
  });
});
