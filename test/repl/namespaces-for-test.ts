import path from 'node:path';
import { module, test } from 'qunitx';
import { namespacesFor, preferredFirst } from '../../lib/repl/session.ts';
import '../helpers/custom-asserts.ts';

// Built with `path.resolve` rather than written as POSIX literals, because `preferredFirst`
// resolves what it was ASKED for and compares it against what was FOUND. Hand-written
// `/p/task/task.ts` only equals that resolution on a platform whose separator is `/`: on Windows
// the comparison was `\p\task\task.ts` against `/p/task/task.ts`, so the override silently
// never applied and the index kept the name. Two Windows lanes were red on main for it.
const at = (...parts: string[]) => path.resolve('/p', ...parts);

const FOUND = [at('task/index.ts'), at('task/task.ts')];

// Two preloads can want one name: `index.ts` is named for the directory holding it and `task.ts`
// for itself, so `qunitx repl lib/task/*` has both asking for `Task`. One keeps it and the other
// is qualified, so neither module is unreachable — which is what used to happen, silently.
module('Repl | naming two preloads that want one name', { concurrency: true }, () => {
  test('one keeps the plain name and the other is qualified by its path', (assert) => {
    const names = namespacesFor(FOUND);

    assert.strictEqual(names.get(at('task/index.ts')), 'Task', 'first in the group keeps it');
    assert.strictEqual(names.get(at('task/task.ts')), 'TaskTask', 'and the other is reachable');
  });

  test('files that want different names are left alone', (assert) => {
    const names = namespacesFor([at('a/one.ts'), at('b/two.ts')]);

    assert.strictEqual(names.get(at('a/one.ts')), 'One');
    assert.strictEqual(names.get(at('b/two.ts')), 'Two');
  });

  test('an index goes first, so it is the one that keeps the name', (assert) => {
    const shuffled = [at('task/task.ts'), at('task/index.ts')];

    assert.strictEqual(preferredFirst(shuffled, ['task/*'], '/p')[0], at('task/index.ts'));
    // Unquoted, the shell hands over two plain paths and no pattern survives — the default has to
    // hold there too, because that is how the case was reported.
    const expanded = ['task/index.ts', 'task/task.ts'];
    assert.strictEqual(preferredFirst(shuffled, expanded, '/p')[0], at('task/index.ts'));
  });

  test('naming a file after a quoted glob puts it first instead', (assert) => {
    const asked = ['task/*', 'task/task.ts'];
    const order = preferredFirst(FOUND, asked, '/p');

    assert.strictEqual(order[0], at('task/task.ts'), 'you asked for it by name');
    assert.strictEqual(namespacesFor(order).get(at('task/task.ts')), 'Task');
    assert.strictEqual(namespacesFor(order).get(at('task/index.ts')), 'TaskIndex');
  });

  test('naming it BEFORE the glob does not, since the pattern came after', (assert) => {
    assert.strictEqual(
      preferredFirst(FOUND, ['task/task.ts', 'task/*'], '/p')[0],
      at('task/index.ts'),
    );
  });

  test('a group with no index keeps the order it had', (assert) => {
    const twins = [at('one/thing.ts'), at('two/thing.ts')];
    const names = namespacesFor(preferredFirst(twins, ['one/thing.ts', 'two/thing.ts'], '/p'));

    assert.strictEqual(names.get(at('one/thing.ts')), 'Thing');
    assert.strictEqual(names.get(at('two/thing.ts')), 'TwoThing', 'qualified until it is unique');
  });
});
