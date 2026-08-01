import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { Failure } from '../../lib/result/index.ts';

const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

// A gate that isn't ready until 'unlock': 'work' messages that arrive early POSTPONE themselves
// (selective receive) and are replayed, in order, once unstashAll runs.
type Gate = { ready: boolean; done: number[] };
const gate = () => ({
  version: '1',
  init: (): Gate => ({ ready: false, done: [] }),
  handlers: {
    work: (state: Gate, n: unknown, self: Node.Self) => {
      if (!state.ready) {
        self.postpone(); // not ready yet — defer this message, reply later
        return { state, reply: undefined };
      }
      return { state: { ...state, done: [...state.done, n as number] }, reply: n };
    },
    unlock: (state: Gate, _p: unknown, self: Node.Self) => {
      self.unstashAll(); // release everything that was waiting
      return { state: { ...state, ready: true }, reply: 'unlocked' };
    },
  },
});

module('Node | selective receive (stash / postpone)', () => {
  test('postponed messages replay in arrival order and reply on unstashAll', async (assert) => {
    const hub = Node.memoryHub();
    const node = Node.start('n@stash', hub.transport());
    const unit = Node.genServer(node, 'gate', gate());

    // Two calls arrive while the gate is locked — both postpone; their callers keep waiting.
    const w1 = unit.call('work', 1);
    const w2 = unit.call('work', 2);
    await settle();

    const unlocked = await unit.call('unlock');
    assert.strictEqual(unlocked, 'unlocked', 'unlock ran');
    assert.strictEqual(await w1, 1, 'the first postponed message replayed and replied');
    assert.strictEqual(await w2, 2, 'the second replayed after it — arrival order preserved');
    node.stop();
  });

  test('messages that arrive AFTER unlock are handled immediately (no over-stashing)', async (assert) => {
    const hub = Node.memoryHub();
    const node = Node.start('n2@stash', hub.transport());
    const unit = Node.genServer(node, 'gate', gate());
    const early = unit.call('work', 1); // postponed
    await unit.call('unlock');
    assert.strictEqual(await early, 1, 'the early one replayed');
    assert.strictEqual(await unit.call('work', 2), 2, 'a later one is handled straight through');
    node.stop();
  });

  test('a postponed caller settles (UnitDown) when the unit stops — it never hangs', async (assert) => {
    const hub = Node.memoryHub();
    const node = Node.start('n3@stash', hub.transport());
    const unit = Node.genServer(node, 'gate', gate());
    const pending = unit.call('work', 1).result(); // postponed, never unlocked
    await settle();
    unit.exit(); // down() flushes the stash so the caller doesn't wait forever
    const outcome = await pending;
    assert.true(Failure.is(outcome), 'the postponed caller settled as a failure, not a hang');
    node.stop();
  });
});
