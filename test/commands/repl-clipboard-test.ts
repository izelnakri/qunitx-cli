import { module, test } from 'qunitx';
import { clipboardCommands } from '../../lib/commands/repl/clipboard.ts';
import '../helpers/custom-asserts.ts';

// Every desktop has a clipboard and no two agree on the name of the thing that writes to it.
module('Commands | repl | the clipboard', { concurrency: true }, () => {
  test('each platform names its own', (assert) => {
    assert.deepEqual(clipboardCommands('darwin'), [['pbcopy', []]]);
    assert.deepEqual(clipboardCommands('win32'), [['clip', []]]);
    assert.deepEqual(
      clipboardCommands('linux').map(([command]) => command),
      ['wl-copy', 'xclip', 'xsel'],
      'Wayland first, then the two X selection owners — a desktop has whichever it has',
    );
  });

  test('a platform nothing here knows is no commands rather than a wrong one', (assert) => {
    assert.deepEqual(clipboardCommands('sunos'), []);
  });
});
