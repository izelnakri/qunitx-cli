import { module, test } from 'qunitx';
import { clipboardCommands, nowhere } from '../../lib/commands/repl/values.ts';
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

// The two ways there can be nothing to say about a name.
module('Commands | repl | nothing to say', { concurrency: true }, () => {
  test('nothing asked is how to ask', (assert) => {
    assert.strictEqual(nowhere('', 'doc'), 'Usage: .doc <value>');
    assert.strictEqual(nowhere('  ', 'copy'), 'Usage: .copy <value>', 'under whichever name');
  });

  test('a name that is not there is the one thing nothing is known about', (assert) => {
    // Every name this session watched arrive has an answer now, whether or not V8 can place it.
    assert.includes(nowhere('helper', 'doc'), 'nothing known about helper');
    assert.includes(nowhere('helper', 'doc'), 'no such name in this session');
  });
});
