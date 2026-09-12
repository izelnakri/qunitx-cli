import { module, test } from 'qunitx';
import { reportCrash } from '../../lib/utils/report-crash.ts';
import * as Result from '../../lib/result/index.ts';
import '../helpers/custom-asserts.ts';

const Unreadable = Result.Failure.define(
  'InputUnreadable',
  (data: { input: string }) => `could not read test input ${data.input}`,
);

module('Utils | reportCrash | ordering', { concurrency: true }, () => {
  test('the message is out before the reap, not after it', (assert) => {
    // The Windows regression this exists for: the crash boundary awaited `shutdownPrelaunch()`
    // first, and that wait can drain the event loop on Windows — Node exits on its own, so a
    // message queued after it is never written. `qunitx repl no-such-file.ts` exited 1 with an
    // empty stderr there while reporting itself correctly everywhere else. A shutdown that never
    // settles reproduces it exactly, on any host.
    const printed: unknown[] = [];
    let reaped = false;

    void reportCrash(
      Unreadable({ input: 'C:\\proj\\test\\no-such.ts' }),
      () =>
        new Promise(() => {
          reaped = true;
        }),
      (line) => void printed.push(line),
    );

    assert.equal(printed.length, 1, 'printed synchronously, before anything is awaited');
    assert.includes(
      String(printed[0]),
      'could not read test input C:\\proj\\test\\no-such.ts',
      'and it names the input it could not read, Windows path and all',
    );
    assert.true(reaped, 'the reap is still asked for — it just does not gate the message');
  });

  test('resolves once the reap does', async (assert) => {
    let reaped = false;
    await reportCrash(
      new Error('boom'),
      () => {
        reaped = true;
        return Promise.resolve();
      },
      () => {},
    );

    assert.true(reaped);
  });
});

module('Utils | reportCrash | two tiers', { concurrency: true }, () => {
  test('a declared failure is rendered as its message', (assert) => {
    const printed: unknown[] = [];
    void reportCrash(
      Unreadable({ input: '/proj/test/no-such.ts' }),
      () => Promise.resolve(),
      (line) => void printed.push(line),
    );

    assert.equal(printed[0], 'InputUnreadable: could not read test input /proj/test/no-such.ts');
  });

  test('a bug is handed over whole, so its stack survives', (assert) => {
    const printed: unknown[] = [];
    const bug = new TypeError('undefined is not a function');
    void reportCrash(
      bug,
      () => Promise.resolve(),
      (line) => void printed.push(line),
    );

    assert.strictEqual(printed[0], bug, 'the Error itself, not a string of it');
  });
});
