import { module, test } from 'qunitx';
import { noSuchValueLine } from '../../lib/commands/repl/no-such-value-line.ts';
import '../helpers/custom-asserts.ts';

// The two ways there can be nothing to say about a name.
module('Commands | repl | noSuchValueLine', { concurrency: true }, () => {
  test('nothing asked is how to ask', (assert) => {
    assert.strictEqual(noSuchValueLine('', 'doc'), 'Usage: .doc <value>');
    assert.strictEqual(
      noSuchValueLine('  ', 'copy'),
      'Usage: .copy <value>',
      'under whichever name',
    );
  });

  test('a name that is not there is the one thing nothing is known about', (assert) => {
    // Every name this session watched arrive has an answer now, whether or not V8 can place it.
    assert.includes(noSuchValueLine('helper', 'doc'), 'nothing known about helper');
    assert.includes(noSuchValueLine('helper', 'doc'), 'no such name in this session');
  });
});
