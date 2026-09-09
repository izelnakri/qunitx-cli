import process from 'node:process';
import { module, test } from 'qunitx';
import { execute } from '../helpers/shell.ts';
import '../helpers/custom-asserts.ts';

/**
 * Whether a window can actually be put on a screen here.
 *
 * A display is only half of it: headed Chrome needs a real Chrome, and the macOS runners install
 * playwright's headless shell instead — which, as its name says, cannot open one. So this asks
 * where both are true, which is a Linux desktop, and trusts `spawn` to be `spawn` elsewhere.
 */
const HAS_A_SCREEN =
  process.platform === 'linux' &&
  (Boolean(process.env.DISPLAY) || Boolean(process.env.WAYLAND_DISPLAY));

// The session drives one page, and these are the two ways to look at it: a window of its own, or
// Chrome's own DevTools opened on the headless one from whatever browser you already have.
module('Flags | --open | repl', { concurrency: true }, () => {
  if (!HAS_A_SCREEN) return;

  test('the window that opens is the page the prompt is talking to', async (assert) => {
    const result = await execute('node cli.ts repl --open --browser=chromium', {
      stdin: "document.body.dataset.from = 'the prompt'\ndocument.body.dataset.from\n",
    });

    assert.exitCode(result, 0);
    assert.includes(result, 'in the window that just opened', 'and the banner says which page');
    assert.includes(result, "'the prompt'", 'a DOM the terminal wrote to and read back');
  });

  test('a window has F12, so it is not offered a DevTools address as well', async (assert) => {
    const result = await execute('node cli.ts repl --open --browser=chromium', {
      stdin: '.devtools\n',
    });

    assert.notIncludes(result, '/devtools —', 'the banner leaves it out');
    assert.includes(result, 'press F12 in the window instead');
  });
});
