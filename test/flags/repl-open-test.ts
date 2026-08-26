import process from 'node:process';
import { module, test } from 'qunitx';
import { execute } from '../helpers/shell.ts';
import '../helpers/custom-asserts.ts';

/** Whether anything on this machine could put a window on a screen. */
const HAS_A_SCREEN =
  process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY) ||
  Boolean(process.env.WAYLAND_DISPLAY);

// `--open` makes the window on your screen the session's own realm: the same globalThis the prompt
// evaluates in, with DevTools available on it. Only asked where there is a screen to open it on —
// a headless CI runner has nothing to answer with.
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
});
