import fs from 'node:fs/promises';
import path from 'node:path';
import { module, test } from 'qunitx';
import { edit, whatToRun } from '../../lib/commands/repl/index.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';
import type { REPLServer } from 'node:repl';

// The scratchpad is the one piece of REPL state an editor round-trip has to preserve: reopening
// continues the same thought rather than starting a blank one, whichever of `.vi`/`.vim`/`.nvim`
// was used. Driven through a stand-in editor rather than a pty, because what is under test is the
// buffer's journey to a file and back, not the terminal handover.
module('Commands | repl | the editor scratchpad', { concurrency: true }, () => {
  const server = {
    paused: 0,
    resumed: 0,
    pause() {
      server.paused += 1;
    },
    resume() {
      server.resumed += 1;
    },
  };

  /** A stand-in for a human: records what it was handed, appends a line, exits. */
  async function fakeEditor(directory: string, appends: string): Promise<string> {
    const editor = path.join(directory, 'fake-editor');
    await fs.writeFile(
      editor,
      `#!/bin/sh\ncat "$1" > "${path.join(directory, 'handed.txt')}"\nprintf '%s\\n' '${appends}' >> "$1"\n`,
    );
    await fs.chmod(editor, 0o755);

    return editor;
  }

  test('what the editor saves is what comes back', async (assert) => {
    await using directory = await tempDir('repl-edit');
    const editor = await fakeEditor(directory.path, 'const a = 1;');

    const saved = await edit(editor, '', server as unknown as REPLServer);

    assert.strictEqual(saved.text, 'const a = 1;\n');
    assert.true(saved.changed, 'and it says the buffer moved, which is what makes it run');
  });

  test('what runs afterwards is what moved, and nothing else', (assert) => {
    // The rule the scratchpad turns on: `:q` means never mind, and a buffer emptied and saved
    // runs nothing for the same reason an empty line does.
    assert.strictEqual(whatToRun({ text: '6 * 7', changed: true }), '6 * 7');
    assert.strictEqual(whatToRun({ text: '6 * 7', changed: false }), '');
    assert.strictEqual(whatToRun({ text: '  \n ', changed: true }), '');
  });

  test('an editor that wrote the same bytes back has changed nothing', async (assert) => {
    // `:w` on a buffer nobody touched. Content is what is compared, not whether a write happened.
    await using directory = await tempDir('repl-edit-rewrite');
    const editor = path.join(directory.path, 'rewriter');
    await fs.writeFile(editor, '#!/bin/sh\ncat "$1" > "$1.copy"\ncat "$1.copy" > "$1"\n');
    await fs.chmod(editor, 0o755);

    const same = await edit(editor, 'const a = 1;\n', server as unknown as REPLServer);

    assert.strictEqual(same.text, 'const a = 1;\n');
    assert.false(same.changed, 'so nothing runs, whatever it did to the mtime');
  });

  test('an editor that saved nothing is a change of mind, not a buffer', async (assert) => {
    // `:q` means "never mind", and a scratchpad that runs what you just walked away from is one
    // you stop using for anything you are not sure about.
    await using directory = await tempDir('repl-edit-quit');
    const editor = path.join(directory.path, 'quitter');
    await fs.writeFile(editor, '#!/bin/sh\nexit 0\n');
    await fs.chmod(editor, 0o755);

    const left = await edit(editor, 'const a = 1;\n', server as unknown as REPLServer);

    assert.strictEqual(left.text, 'const a = 1;\n', 'the buffer is still there to reopen');
    assert.false(left.changed, 'but nothing about it is new, so nothing runs');
  });

  test('reopening hands the editor the buffer it left behind', async (assert) => {
    // The whole point of keeping it in memory. Without this the second open is a blank file and
    // everything typed into the first is gone.
    await using directory = await tempDir('repl-edit-again');
    const editor = await fakeEditor(directory.path, 'const b = 2;');

    const first = await edit(editor, 'const a = 1;\n', server as unknown as REPLServer);
    const handed = await fs.readFile(path.join(directory.path, 'handed.txt'), 'utf8');

    assert.strictEqual(handed, 'const a = 1;\n', 'it opened on what was already there');
    assert.strictEqual(first.text, 'const a = 1;\nconst b = 2;\n', 'and kept both');
  });

  test('an editor that will not start leaves the buffer as it was', async (assert) => {
    const kept = await edit(
      'definitely-not-an-editor-anywhere',
      'const a = 1;\n',
      server as unknown as REPLServer,
    );

    assert.strictEqual(kept.text, 'const a = 1;\n', 'nothing typed is lost to a missing editor');
    assert.false(kept.changed, 'and an editor that never ran changed nothing');
  });

  test('the prompt is paused for the editor and resumed after, every time', async (assert) => {
    // Getting this wrong does not look like a bug, it looks like a dead terminal: readline and the
    // editor both want the TTY, and only one of them can have it. Its own counter, because these
    // tests run concurrently and a shared one counts everybody's turns.
    const counted = { paused: 0, resumed: 0 };
    const own = {
      pause: () => void (counted.paused += 1),
      resume: () => void (counted.resumed += 1),
    };

    await edit('definitely-not-an-editor-anywhere', '', own as unknown as REPLServer);

    assert.deepEqual(counted, { paused: 1, resumed: 1 }, 'resumed even when the editor failed');
  });

  test('stdin is left as it was found, and a prompt that never had it does not get it', async (assert) => {
    // A leak that costs 240 seconds and looks like a hung test suite: `resume()` on a stream
    // nothing was reading does not restore anything, it starts something, and stdin flowing with
    // no reader holds the event loop open for the life of the process. So does `read()`, which
    // restarts the flow it drains. Nothing here is reading stdin, and nothing should be after.
    await edit('definitely-not-an-editor-anywhere', '', server as unknown as REPLServer);

    assert.notStrictEqual(
      process.stdin.readableFlowing,
      true,
      'the editor handover did not hand the terminal to a prompt that never asked for it',
    );
  });
});
