import { module, test } from 'qunitx';
import { memoryStore } from '../../lib/node/index.ts';
import { saga } from '../../lib/saga/index.ts';

module('Saga | distributed transactions with compensation', () => {
  test('the happy path runs every step and threads results into the context', async (assert) => {
    const s = saga<{ reserve?: string; charge?: string }>([
      { name: 'reserve', run: () => 'seat-7' },
      { name: 'charge', run: (ctx) => `paid-for-${ctx.reserve}` },
    ]);
    const result = await s.execute({});
    assert.true(result.ok);
    if (result.ok) {
      assert.equal(result.ctx.reserve, 'seat-7');
      assert.equal(result.ctx.charge, 'paid-for-seat-7', 'a later step saw the earlier result');
    }
  });

  test('a failing step compensates the completed ones IN REVERSE', async (assert) => {
    const log: string[] = [];
    const s = saga([
      { name: 'debit', run: () => log.push('debit'), compensate: () => void log.push('un-debit') },
      {
        name: 'credit',
        run: () => log.push('credit'),
        compensate: () => void log.push('un-credit'),
      },
      {
        name: 'book',
        run: () => {
          throw new Error('inventory gone');
        },
        compensate: () => void log.push('un-book'),
      },
    ]);
    const result = await s.execute({});
    assert.false(result.ok);
    if (!result.ok) {
      assert.equal(result.failedAt, 'book');
      assert.deepEqual(
        result.compensated,
        ['credit', 'debit'],
        'reverse order, and NOT the failed step',
      );
    }
    assert.deepEqual(
      log,
      ['debit', 'credit', 'un-credit', 'un-debit'],
      'the world was rolled back',
    );
  });

  test('a compensation that throws does not abort the rest of the rollback', async (assert) => {
    const undone: string[] = [];
    const s = saga([
      { name: 'a', run: () => 1, compensate: () => void undone.push('a') },
      {
        name: 'b',
        run: () => 2,
        compensate: () => {
          throw new Error('undo b failed');
        },
      },
      {
        name: 'c',
        run: () => {
          throw new Error('c failed');
        },
      },
    ]);
    const result = await s.execute({});
    assert.false(result.ok);
    assert.deepEqual(undone, ['a'], "a's compensation still ran despite b's throwing");
  });

  test('a flaky forward step retries before failing', async (assert) => {
    let calls = 0;
    const s = saga([
      {
        name: 'flaky',
        retries: 2,
        run: () => {
          if (++calls < 3) throw new Error(`attempt ${calls}`);
          return 'ok';
        },
      },
    ]);
    const result = await s.execute({});
    assert.true(result.ok, 'succeeded on the third attempt');
    assert.equal(calls, 3);
  });

  test('durable recovery: a crash-stranded saga is rolled back from its log', async (assert) => {
    const store = memoryStore();
    const undone: string[] = [];
    const steps = [
      { name: 'reserve', run: () => 'seat', compensate: () => void undone.push('reserve') },
      { name: 'charge', run: () => 'ch_1', compensate: () => void undone.push('charge') },
      // 'ship' never runs — the process "crashes" after 'charge' persists.
      { name: 'ship', run: () => 'shipment', compensate: () => void undone.push('ship') },
    ];

    // Simulate a crash: run only the first two steps by hand, persisting the log the saga would.
    await store.save('saga:order-9', {
      completed: [
        { name: 'reserve', result: 'seat' },
        { name: 'charge', result: 'ch_1' },
      ],
    });

    // A recovery process picks it up and rolls the stranded saga back.
    const result = await saga(steps, { store, id: 'order-9' }).recover({});
    assert.false(result.ok);
    assert.deepEqual(
      undone,
      ['charge', 'reserve'],
      'the two committed steps compensated in reverse',
    );
    assert.equal(await store.load('saga:order-9'), undefined, 'the log is cleared after rollback');
  });

  test('a committed saga leaves no durable rollback log', async (assert) => {
    const store = memoryStore();
    const result = await saga([{ name: 'a', run: () => 1 }], { store, id: 'clean' }).execute({});
    assert.true(result.ok);
    assert.equal(
      await store.load('saga:clean'),
      undefined,
      'a fully-committed saga forgets its log',
    );
  });
});
