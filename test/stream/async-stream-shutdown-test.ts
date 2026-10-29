import process from 'node:process';
import { module, test } from 'qunitx';
import { Stream } from '../../lib/stream/index.ts';

// Apart from stream-test.ts, which test/browser-suite.ts also runs in a page: watching for an
// unhandled rejection needs `process`.
module('Stream | asyncStream | a consumer that stops', () => {
  test('a failure stops the rest: siblings still running are shut down, and their own failures are not unhandled', async (assert) => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      for (const ordered of [true, false]) {
        const aborted: number[] = [];
        // 0 fails first; 1 and 2 are still running then, and 1 fails after it.
        const outcome = Stream.asyncStream(
          [0, 1, 2, 3],
          async (n, signal) => {
            signal.addEventListener('abort', () => aborted.push(n));
            await new Promise((resolve) => setTimeout(resolve, n === 0 ? 5 : 40));
            if (n < 2) throw new Error(`sibling ${n} failed`);
            return n;
          },
          { maxConcurrency: 3, ordered },
        ).collect();

        await assert.rejects(outcome, /sibling 0 failed/, `ordered: ${ordered}`);
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.deepEqual(aborted, [1, 2], `ordered: ${ordered}: the two still running`);
      }
    } finally {
      process.off('unhandledRejection', record);
    }
    assert.deepEqual(
      unhandled.map(String).filter((reason) => reason.includes('sibling')),
      [],
    );
  });
});
