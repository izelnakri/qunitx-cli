import { module, test } from 'qunitx';
import { namespacesTaken } from '../../../lib/commands/repl/index.ts';
import '../../helpers/custom-asserts.ts';

// `qunitx repl lib/task/*` loads both `index.ts` — named for the directory holding it — and
// `task.ts`, named for itself. Both want `Task`, `task.ts` also exports a class called `Task`,
// and the last claim won silently: `Task` at the prompt was the class, and neither module
// namespace was reachable, with nothing said about it.
module('Commands | repl | two files, one name', { concurrency: true }, () => {
  test('an index and its sibling both want the directory’s name', (assert) => {
    const notes = namespacesTaken(['lib/task/index.ts', 'lib/task/task.ts']);

    assert.strictEqual(notes.length, 1, 'said once, not once per file');
    assert.includes(notes[0] ?? '', 'lib/task/index.ts and lib/task/task.ts');
    assert.includes(notes[0] ?? '', 'as Task', 'and names the name they are fighting over');
  });

  test('files that do not collide say nothing', (assert) => {
    assert.deepEqual(namespacesTaken(['lib/task/task.ts']), [], 'one file cannot clash');
    assert.deepEqual(namespacesTaken(['a/one.ts', 'b/two.ts']), [], 'nor can two unrelated ones');
    // The ordinary shape of a session, and the false positive this used to have: the name a file
    // arrives under is listed among its exports, so every single preload looked self-shadowed.
    assert.deepEqual(namespacesTaken(['test/fixtures/repl-helpers.ts']), []);
  });

  test('three claimants are one note naming all three', (assert) => {
    const notes = namespacesTaken(['x/task/index.ts', 'x/task/task.ts', 'y/task.ts']);

    assert.strictEqual(notes.length, 1);
    assert.includes(notes[0] ?? '', 'y/task.ts', 'every file that wanted it is named');
  });
});
