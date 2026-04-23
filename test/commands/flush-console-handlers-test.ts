import { module, test } from 'qunitx';
import { flushConsoleHandlers } from '../../lib/commands/run/tests-in-browser.ts';

module('Commands | run | flushConsoleHandlers', { concurrency: true }, () => {
  test('returns without error when handlers is null', async (assert) => {
    await flushConsoleHandlers(null);
    assert.ok(true);
  });

  test('returns without error when handlers is undefined', async (assert) => {
    await flushConsoleHandlers(undefined);
    assert.ok(true);
  });

  test('awaits a handler present in the Set at call time', async (assert) => {
    const handlers = new Set<Promise<void>>();
    const sideEffects: number[] = [];
    const p = (async () => {
      sideEffects.push(1);
    })();
    handlers.add(p);
    p.finally(() => handlers.delete(p));

    await flushConsoleHandlers(handlers);
    assert.deepEqual(sideEffects, [1]);
  });

  test('awaits a handler added asynchronously via setImmediate (simulates late CDP event)', async (assert) => {
    const handlers = new Set<Promise<void>>();
    const sideEffects: number[] = [];

    // Simulate a CDP console event arriving after the current sync call but before
    // the next I/O poll cycle completes — the same race as in the timezone test.
    setImmediate(() => {
      const p = (async () => {
        await Promise.resolve(); // mimic async CDP jsonValue() fetch
        sideEffects.push(1);
      })();
      handlers.add(p);
      p.finally(() => handlers.delete(p));
    });

    await flushConsoleHandlers(handlers);
    assert.deepEqual(sideEffects, [1], 'late-registered handler side effect was awaited');
  });
});
