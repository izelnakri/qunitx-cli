import { module, test } from 'qunitx';
import { Node, memoryHub, Process } from '../../lib/node/index.ts';
import { Failure } from '../../lib/result/index.ts';

const counter = () => ({
  version: '1',
  init: () => 0,
  handlers: {
    bump: (n: number) => ({ state: n + 1, reply: n + 1 }),
    whoami: (n: number, _p: unknown, self: { name: string }) => ({ state: n, reply: self.name }),
  },
});

module('Node | Process (Elixir Process module)', () => {
  test('spawn creates an anonymous, handle-addressed unit; each name is unique', async (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    const a = Process.spawn(node, counter());
    const b = Process.spawn(node, counter());

    // Independent units — bumping one doesn't touch the other.
    assert.strictEqual(await a.call('bump'), 1);
    assert.strictEqual(await a.call('bump'), 2);
    assert.strictEqual(await b.call('bump'), 1, 'b is a separate unit with its own state');

    const [nameA, nameB] = [await a.call('whoami'), await b.call('whoami')];
    assert.notStrictEqual(nameA, nameB, 'each spawn got a distinct auto-name');
    assert.true(
      String(nameA).startsWith('a@proc:proc:'),
      'the auto-name is node-scoped (<node>:proc:<n>)',
    );
    node.stop();
  });

  test('alive / exit are the free-function forms of the handle ops', (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    const unit = Process.spawn(node, counter());
    assert.true(Process.alive(unit), 'a fresh unit is alive');
    Process.exit(unit);
    assert.false(Process.alive(unit), 'Process.exit terminated it');
    node.stop();
  });

  test('link propagates an exit — a linked unit dies with its partner', (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    const boss = Process.spawn(node, counter());
    const worker = Process.spawn(node, counter());
    Process.link(boss, worker);

    const Boom = Failure.define('Boom', 'boss died');
    Process.exit(boss, Boom());
    assert.false(Process.alive(boss), 'the boss exited');
    assert.false(Process.alive(worker), 'the linked worker died with it (no trap)');
    node.stop();
  });

  test('whereis resolves a via-registered name to its host node', (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    Process.spawn(node, counter(), { via: { registry: 'reg', key: 'k1' } });

    assert.strictEqual(
      Process.whereis(node, 'reg', 'k1'),
      'a@proc',
      'the registered unit is hosted here',
    );
    assert.strictEqual(
      Process.whereis(node, 'reg', 'nope'),
      null,
      'an unknown key resolves to null',
    );
    node.stop();
  });
});
