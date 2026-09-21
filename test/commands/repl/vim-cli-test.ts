import process from 'node:process';
import { module, test } from 'qunitx';
import { randomUUID } from 'node:crypto';
import { spawnCapture } from '../../helpers/shell.ts';
import '../../helpers/custom-asserts.ts';

const ESC = String.fromCharCode(27);
/** The banner's last line: the prompt is reading. What a test waits for instead of a clock. */
const READY = /type `\.help` for commands/;

// Vim mode only exists on a terminal, and only a pty is one. `script` is the pty every Linux has;
// the macOS spelling differs and Windows has none, so this asks on Linux and trusts the
// keystroke-level tests in `vim-mode-test.ts` to cover the rest.
const onLinux = process.platform === 'linux';

module('Commands | repl | vim mode at a real terminal', { concurrency: true }, () => {
  if (!onLinux) {
    test('skipped: this needs a pty, and `script` is the Linux one', (assert) => {
      assert.ok(true);
    });
  }

  if (onLinux) {
    test('normal mode edits the line instead of typing into it', async (assert) => {
      // `x` takes the last `1`, `a` appends after the caret, `2` is typed — so a prompt that
      // understood any of it answers 3, and one that typed the keys answers something else.
      const result = await session(`1 + 1${ESC}xa2\r.exit\r`);

      assert.exitCode(result, 0);
      assert.includes(result, '3');
      // Not `notIncludes('xa2')`: a pty ECHOES what was typed, so those characters are in the
      // output whatever the prompt did with them. `3` is the proof — had the keys been typed,
      // the line would have been `1 + 1xa2` and the answer a SyntaxError.
      assert.notIncludes(result, 'SyntaxError');
    });

    test('dd clears the line, which is how a mistake is abandoned', async (assert) => {
      const result = await session(`boom()${ESC}ddi1 + 1\r.exit\r`);

      assert.exitCode(result, 0);
      assert.includes(result, '2');
      assert.notIncludes(result, 'boom is not defined', 'the line never ran');
    });

    test('a text object reaches inside the quotes', async (assert) => {
      const result = await session(`const a = "old"${ESC}ci"new\r a\r.exit\r`);

      assert.exitCode(result, 0);
      assert.includes(result, "'new'");
      assert.notIncludes(result, "'old'", 'which is what was there before `ci"`');
    });

    test('the caret says which mode you are in', async (assert) => {
      const result = await session(`1${ESC}\r.exit\r`);

      assert.includes(result, `${ESC}[2 q`, 'a block on the way into normal mode');
      assert.includes(result, `${ESC}[6 q`, 'and a bar for insert');
      assert.includes(result, `${ESC}[0 q`, 'put back on the way out');
    });

    test('without it, the same keys are ordinary input', async (assert) => {
      // The whole feature is opt-in, and this is the assertion that keeps it that way.
      const result = await session(`'a'${ESC}x\r.exit\r`, { vim: false });

      assert.exitCode(result, 0);
      assert.notIncludes(result, `${ESC}[2 q`, 'no mode caret, because there are no modes');
    });

    test('QUNITX_REPL_VIM turns it on without the flag', async (assert) => {
      // A preference about your hands belongs in an environment you set once, beside
      // QUNITX_REPL_THEME — not on every invocation.
      const result = await session(`1 + 1${ESC}xa2\r.exit\r`, { vim: false, env: true });

      assert.exitCode(result, 0);
      assert.includes(result, '3');
    });
  }
});

/** One `qunitx repl` through a pty, with the keys typed once the prompt is reading. */
function session(keys: string, options: { vim?: boolean; env?: boolean } = {}) {
  const flag = options.vim === false ? '' : ' --vim';
  const environment = options.env ? 'QUNITX_REPL_VIM=1 ' : '';
  const inner =
    `${environment}node cli.ts repl${flag} --browser=chromium ` +
    `--output=tmp/run-${randomUUID()}`;

  return spawnCapture(`script -qec "${inner}" /dev/null`, {
    stdin: [{ text: keys, after: READY }],
  });
}
