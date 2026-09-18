import { module, test } from 'qunitx';
import { moduleNameFor } from '../../lib/repl/session.ts';
import '../helpers/custom-asserts.ts';

// Elixir's path-to-module rule, because it is the one that turns a filename into something a
// person can type at a prompt without looking it up.
module('Repl | moduleNameFor', { concurrency: true }, () => {
  test('a path becomes the name its words spell', (assert) => {
    assert.strictEqual(moduleNameFor('test/fixtures/repl-helpers.ts'), 'ReplHelpers');
    assert.strictEqual(moduleNameFor('lib/my_app/user.ts'), 'User');
    assert.strictEqual(moduleNameFor('./some.thing.js'), 'SomeThing', 'dots are word breaks too');
    assert.strictEqual(moduleNameFor('package.json'), 'Package');
  });

  test('an index is named for what it is the index of', (assert) => {
    // Every folder has one, and a session with three `Index` objects in it has none.
    assert.strictEqual(moduleNameFor('lib/repl/index.ts'), 'Repl');
    assert.strictEqual(moduleNameFor('lib/repl/mod.ts'), 'Repl');
    assert.strictEqual(moduleNameFor('index.js'), 'Index', 'unless there is no directory to take');
  });

  test('a windows path is a path', (assert) => {
    assert.strictEqual(moduleNameFor('test\\fixtures\\repl-helpers.ts'), 'ReplHelpers');
  });

  test('what would not be typeable is made so', (assert) => {
    assert.strictEqual(moduleNameFor('3-blind-mice.ts'), 'Module3BlindMice', 'no leading digit');
    assert.strictEqual(moduleNameFor('déjà-vu.ts'), 'DéjàVu', 'letters are letters');
    assert.strictEqual(moduleNameFor('!!!.ts'), 'Module', 'and a name of nothing is still a name');
  });
});
