import { module, test } from 'qunitx';
import { command as clear } from '../../lib/commands/repl/commands/clear.ts';
import '../helpers/custom-asserts.ts';

import type { ReplContext } from '../../lib/commands/repl/command.ts';

const ESC = String.fromCharCode(27);

/** A context that records what was written to it, and whether it claims a screen. */
function watching(interactive: boolean) {
  const written: string[] = [];

  return {
    written,
    repl: { interactive, write: (text: string) => written.push(text) } as unknown as ReplContext,
  };
}

// The scrollback is the part worth protecting: a `.clear` that threw away the last hour of a
// session would be worse than no `.clear` at all, and nothing but a test says which escape went.
module('Commands | repl | .clear', { concurrency: true }, () => {
  test('it clears the screen and leaves the scrollback alone', (assert) => {
    const { repl, written } = watching(true);
    clear.main(repl, '');

    assert.strictEqual(written.join(''), `${ESC}[H${ESC}[2J`, 'home, then erase what is on screen');
    assert.notIncludes(written.join(''), '[3J', 'never the one that erases the scrollback');
  });

  test('nothing is written where there is no screen', (assert) => {
    const { repl, written } = watching(false);
    clear.main(repl, '');

    assert.deepEqual(written, [], 'a pipe would carry the escape as text');
  });
});
