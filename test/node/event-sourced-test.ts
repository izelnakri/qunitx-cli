import { module, test } from 'qunitx';
import { eventSourced, type Aggregate } from '../../lib/node/event-sourced.ts';
import { memoryStore } from '../../lib/node/store.ts';

// A tiny bank account aggregate: deposits credit, withdrawals debit but only if funds cover them
// (the rejection path emits no event).
type Account = { balance: number };
type Command = { deposit: number } | { withdraw: number };
type Event = { credited: number } | { debited: number };

const account: Aggregate<Account, Command, Event> = {
  init: () => ({ balance: 0 }),
  decide: (state, command) => {
    if ('deposit' in command) return command.deposit > 0 ? [{ credited: command.deposit }] : [];
    return command.withdraw <= state.balance ? [{ debited: command.withdraw }] : [];
  },
  apply: (state, event) => ({
    balance: state.balance + ('credited' in event ? event.credited : -event.debited),
  }),
};

module('Node | event sourcing (eventSourced)', () => {
  test('execute decides, persists, and folds — state is the log projection', async (assert) => {
    const bank = eventSourced('acct1', account, { store: memoryStore() });
    await bank.ready();
    assert.deepEqual(
      await bank.execute({ deposit: 100 }),
      [{ credited: 100 }],
      'emitted the event',
    );
    await bank.execute({ deposit: 50 });
    await bank.execute({ withdraw: 30 });
    assert.strictEqual(bank.state().balance, 120, 'state is the fold of the events');
    assert.strictEqual(bank.version(), 3, 'three events committed');
  });

  test('a rejected command emits no event and does not advance the log', async (assert) => {
    const bank = eventSourced('acct2', account, { store: memoryStore() });
    await bank.ready();
    await bank.execute({ deposit: 40 });
    const events = await bank.execute({ withdraw: 100 }); // over balance — rejected
    assert.deepEqual(events, [], 'no event emitted for the rejected command');
    assert.strictEqual(bank.state().balance, 40, 'state unchanged');
    assert.strictEqual(bank.version(), 1, 'the log did not advance');
  });

  test('a fresh instance REPLAYS the persisted log to the same state', async (assert) => {
    const store = memoryStore();
    const first = eventSourced('acct3', account, { store });
    await first.ready();
    await first.execute({ deposit: 200 });
    await first.execute({ withdraw: 75 });

    // A brand-new aggregate over the SAME store + name rebuilds state from the event log.
    const revived = eventSourced('acct3', account, { store });
    await revived.ready();
    assert.strictEqual(revived.state().balance, 125, 'replayed to the identical balance');
    assert.strictEqual(revived.version(), 2, 'and the identical version');
  });

  test('snapshots bound replay and still reconstruct the exact state', async (assert) => {
    const store = memoryStore();
    const first = eventSourced('acct4', account, { store, snapshotEvery: 2 });
    await first.ready();
    for (let i = 0; i < 5; i += 1) await first.execute({ deposit: 10 }); // 5 events, snapshot at 2 & 4

    // A snapshot exists; a revived instance replays from it plus the tail — same state.
    assert.notStrictEqual(await store.load('acct4::snap'), undefined, 'a snapshot was written');
    const revived = eventSourced('acct4', account, { store, snapshotEvery: 2 });
    await revived.ready();
    assert.strictEqual(revived.state().balance, 50, 'snapshot + tail replayed to the exact state');
    assert.strictEqual(revived.version(), 5, 'version preserved across the snapshot boundary');
  });

  test('concurrent executes serialize — no interleaved decision, no lost event', async (assert) => {
    const bank = eventSourced('acct5', account, { store: memoryStore() });
    await bank.ready();
    // Fire 20 deposits at once; they must all land, each folded on the previous (no lost updates).
    await Promise.all(Array.from({ length: 20 }, () => bank.execute({ deposit: 5 })));
    assert.strictEqual(bank.state().balance, 100, 'every concurrent deposit was applied in order');
    assert.strictEqual(bank.version(), 20, 'all 20 events committed');
  });
});
