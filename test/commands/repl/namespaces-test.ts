import { module, test } from 'qunitx';
import { renamedNamespaces } from '../../../lib/commands/repl/index.ts';
import '../../helpers/custom-asserts.ts';

// A file that lost a name clash answers to something its path does not obviously suggest, so the
// banner says so. `qunitx repl lib/task/*` is the case: `index.ts` keeps `Task` and `task.ts`
// becomes `TaskTask`, which nobody would guess.
module('Commands | repl | a preload that was renamed', { concurrency: true }, () => {
  test('it says the new name and who took the old one', (assert) => {
    const notes = renamedNamespaces([
      ['lib/task/index.ts', ['Task']],
      ['lib/task/task.ts', ['TaskTask']],
    ]);

    assert.strictEqual(notes.length, 1, 'only the file that lost is worth a line');
    assert.includes(notes[0] ?? '', 'lib/task/task.ts is TaskTask');
    assert.includes(notes[0] ?? '', 'lib/task/index.ts took Task');
  });

  test('a preload that got the name it asked for says nothing', (assert) => {
    assert.deepEqual(renamedNamespaces([['lib/task/index.ts', ['Task']]]), []);
    // A single preload spreads its exports too, and the module's own name leads that list.
    assert.deepEqual(
      renamedNamespaces([['test/fixtures/repl-helpers.ts', ['ReplHelpers', 'GREETING', 'double']]]),
      [],
    );
    assert.deepEqual(renamedNamespaces([]), []);
  });
});
