import fs from 'node:fs/promises';
import path from 'node:path';
import { module, test } from 'qunitx';
import { trimHistoryFile } from '../../lib/commands/repl/index.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

// `node:repl` writes the whole history at position 0 and never shortens the file, so a write
// smaller than the one before leaves the tail of the old one behind. The file is newest first, so
// that tail lands on the end of the OLDEST entry and becomes part of it — a dozen half-lines glued
// into one, offered as a suggestion the moment you type something it starts with.
module('Commands | repl | the history file', { concurrency: true }, () => {
  const write = async (directory: string, contents: string) => {
    const file = path.join(directory, 'history');
    await fs.writeFile(file, contents);

    return file;
  };

  test('a leftover tail is cut off', async (assert) => {
    await using directory = await tempDir('history-trim');
    // What is on disk after a longer write; what the history now holds is the first two lines.
    const file = await write(directory.path, 'newest\nolder\nLEFTOVER FROM A LONGER WRITE');

    trimHistoryFile(file, ['newest', 'older']);

    assert.strictEqual(await fs.readFile(file, 'utf8'), 'newest\nolder');
  });

  test('a file that already fits is untouched', async (assert) => {
    await using directory = await tempDir('history-fits');
    const file = await write(directory.path, 'newest\nolder');

    trimHistoryFile(file, ['newest', 'older']);

    assert.strictEqual(await fs.readFile(file, 'utf8'), 'newest\nolder');
  });

  test('a file shorter than the history is never padded out', async (assert) => {
    // `truncate` grows a file with zero bytes, and a history full of NULs is a worse problem than
    // the one this solves.
    await using directory = await tempDir('history-short');
    const file = await write(directory.path, 'newest');

    trimHistoryFile(file, ['newest', 'older', 'oldest']);

    assert.strictEqual(await fs.readFile(file, 'utf8'), 'newest');
  });

  test('multi-byte characters are counted in bytes, not characters', async (assert) => {
    // The entry is what has to survive; cutting to a character count would slice a character in
    // half and leave a broken one at the end of the file.
    await using directory = await tempDir('history-bytes');
    const file = await write(directory.path, "const a = 'héllo — ok'\nLEFTOVER");

    trimHistoryFile(file, ["const a = 'héllo — ok'"]);

    assert.strictEqual(await fs.readFile(file, 'utf8'), "const a = 'héllo — ok'");
  });

  test('a file that is not there is not a failure', async (assert) => {
    await using directory = await tempDir('history-missing');

    trimHistoryFile(path.join(directory.path, 'nope'), ['a']);

    assert.ok(true, 'a history file is a convenience, and tidying one is never worth an error');
  });
});
