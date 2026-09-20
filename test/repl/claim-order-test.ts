import { module, test } from 'qunitx';
import { inClaimOrder } from '../../lib/repl/session.ts';
import '../helpers/custom-asserts.ts';

const FOUND = ['/p/task/index.ts', '/p/task/task.ts'];
const last = (files: readonly string[]) => files[files.length - 1];

// Preloads are brought in list order and the last claim keeps the name, so the order IS the
// precedence. `qunitx repl lib/task/*` used to give `Task` to `task.ts` for no better reason
// than the alphabet — an index is the door into a directory, so it wins by default.
module('Repl | which preload keeps a shared name', { concurrency: true }, () => {
  test('an index wins a name its sibling also wants', (assert) => {
    assert.strictEqual(last(inClaimOrder(FOUND, ['task/*'], '/p')), '/p/task/index.ts');
    // Unquoted, the shell hands over two plain paths and no pattern survives — the default has
    // to hold there too, because that is how the case was actually reported.
    const expanded = ['task/index.ts', 'task/task.ts'];
    assert.strictEqual(last(inClaimOrder(FOUND, expanded, '/p')), '/p/task/index.ts');
  });

  test('naming a file after a quoted glob beats the index', (assert) => {
    const asked = ['task/*', 'task/task.ts'];

    assert.strictEqual(last(inClaimOrder(FOUND, asked, '/p')), '/p/task/task.ts');
  });

  test('naming it BEFORE the glob does not, since the pattern came after', (assert) => {
    const asked = ['task/task.ts', 'task/*'];

    assert.strictEqual(last(inClaimOrder(FOUND, asked, '/p')), '/p/task/index.ts');
  });

  test('files that share no name are left exactly as they were', (assert) => {
    const unrelated = ['/p/a/one.ts', '/p/b/two.ts'];

    assert.deepEqual(inClaimOrder(unrelated, ['a/one.ts', 'b/two.ts'], '/p'), unrelated);
    assert.deepEqual(inClaimOrder([], [], '/p'), [], 'and nothing is nothing');
  });

  test('a group with no index keeps whatever order it had', (assert) => {
    const twins = ['/p/one/thing.ts', '/p/two/thing.ts'];

    assert.deepEqual(inClaimOrder(twins, ['one/thing.ts', 'two/thing.ts'], '/p'), twins);
  });
});
