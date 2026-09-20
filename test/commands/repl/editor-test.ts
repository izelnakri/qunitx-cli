import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { module, test } from 'qunitx';
import {
  edit,
  formatPathDisplay,
  userMeansYes,
  whatToRun,
} from '../../../lib/commands/repl/index.ts';
import { tempDir } from '../../helpers/temp-dir.ts';
import '../../helpers/custom-asserts.ts';
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

  // `:wq`, `:x` and `:w` then `:q!` leave a byte-identical file, all exit 0, and differ by about
  // four milliseconds between the write and the exit — measured. There is nothing there to infer
  // an intention from, so the prompt asks, and this is how it reads the answer.
  test('Enter or a y means run it, and nothing else does', (assert) => {
    assert.true(userMeansYes(''), 'Enter takes the default');
    assert.true(userMeansYes('y'));
    assert.true(userMeansYes('  YES  '), 'trimmed, and case does not matter');
    assert.false(userMeansYes('n'));
    assert.false(userMeansYes('nope'));
    // Stricter than the usual anything-but-n, because this one runs code: a mistyped command at
    // the prompt must not be read as consent.
    assert.false(userMeansYes('.exit'), 'a stray command is not a yes');
    assert.false(userMeansYes('6 * 7'));
  });

  test('a path is said the way a person would say it', (assert) => {
    assert.strictEqual(
      formatPathDisplay('/home/me/proj/lib/a.ts', '/home/me/proj'),
      'proj/lib/a.ts',
    );
    assert.strictEqual(formatPathDisplay('/etc/hosts', '/home/me/proj'), '/etc/hosts');
    // The project's own name leads, because `lib/a.ts` stops being unambiguous the moment a
    // session has imported something from a sibling checkout.
    assert.includes(formatPathDisplay('/home/me/proj/a.ts', '/home/me/proj'), 'proj/a.ts');
  });

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

  // A stand-in editor is a shell script, and a shell script is not a program on Windows — Node
  // refuses to spawn a `.cmd` without a shell, and a real editor is not a `.cmd`. What these four
  // check is the buffer's journey to a file and back, which has nothing platform-specific in it;
  // the handover below, which does, is asked everywhere.
  if (process.platform !== 'win32') {
    test('an editor that exits non-zero means never mind, however much was saved', async (assert) => {
      await using directory = await tempDir('repl-edit-abort');
      const editor = path.join(directory.path, 'aborting');
      await fs.writeFile(editor, `#!/bin/sh\nprintf '6 * 7\\n' > "$1"\nexit 1\n`);
      await fs.chmod(editor, 0o755);

      const left = await edit(editor, '', server as unknown as REPLServer);

      assert.true(left.saved, 'the editor did write it');
      assert.true(left.aborted, 'and the editor said to drop it anyway');
      assert.strictEqual(whatToRun(left), '', 'so nothing runs');
    });

    test('what the editor saves is what comes back', async (assert) => {
      await using directory = await tempDir('repl-edit');
      const editor = await fakeEditor(directory.path, 'const a = 1;');

      const saved = await edit(editor, '', server as unknown as REPLServer);

      assert.strictEqual(saved.text, 'const a = 1;\n');
      assert.true(saved.saved, 'and it says the editor wrote it, which is what offers it');
    });

    test('what runs afterwards is what moved, and nothing else', (assert) => {
      // The rule the scratchpad turns on: `:q` means never mind, and a buffer emptied and saved
      // runs nothing for the same reason an empty line does.
      assert.strictEqual(whatToRun({ text: '6 * 7', saved: true, aborted: false }), '6 * 7');
      assert.strictEqual(whatToRun({ text: '6 * 7', saved: false, aborted: false }), '');
      assert.strictEqual(whatToRun({ text: '  \n ', saved: true, aborted: false }), '');
      // Saved, and then told to throw it away. `:cq` is the only "never mind" an editor can send
      // after a write, because `:wq` and `:w` then `:q` leave a byte-identical file and both
      // exit 0 — there is nothing else to tell them apart by.
      assert.strictEqual(whatToRun({ text: '6 * 7', saved: true, aborted: true }), '');
    });

    test('an editor that wrote the same bytes back still saved', async (assert) => {
      // `:w` on a buffer nobody touched IS a save, and this used to say otherwise. The cost was
      // an alternating session: decline a run, reopen, `:wq` without editing — identical text, so
      // nothing was offered and every other `.e` looked ignored. A WRITE is the question now.
      await using directory = await tempDir('repl-edit-rewrite');
      const editor = path.join(directory.path, 'rewriter');
      await fs.writeFile(editor, '#!/bin/sh\ncat "$1" > "$1.copy"\ncat "$1.copy" > "$1"\n');
      await fs.chmod(editor, 0o755);

      const same = await edit(editor, 'const a = 1;\n', server as unknown as REPLServer);

      assert.strictEqual(same.text, 'const a = 1;\n');
      assert.true(same.saved, 'so it is offered, because you did ask for it to be written');
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
      assert.false(left.saved, 'but nothing about it is new, so nothing runs');
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
  }

  test('an editor that will not start leaves the buffer as it was', async (assert) => {
    const kept = await edit(
      'definitely-not-an-editor-anywhere',
      'const a = 1;\n',
      server as unknown as REPLServer,
    );

    assert.strictEqual(kept.text, 'const a = 1;\n', 'nothing typed is lost to a missing editor');
    assert.false(kept.saved, 'and an editor that never ran wrote nothing');
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
