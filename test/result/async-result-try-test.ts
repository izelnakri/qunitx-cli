import { module, test } from 'qunitx';
import { AsyncResult, Failure, type Result } from '../../lib/result/index.ts';

const Boom = Failure.define('Boom', (data: { at: string }) => `boom at ${data.at}`);

// A plain async producer: a normal `Promise<T>` that *rejects* with a Failure. No Task, no
// value-first Result — exactly the "existing Promise-returning function" the design targets.
async function loadUser(id: number, tag: string): Promise<{ id: number; tag: string }> {
  if (id <= 0) throw Boom({ at: `loadUser(${id})` });
  return { id, tag };
}

module('AsyncResult.try | the (fn, ...args) boundary', { concurrency: true }, () => {
  test('reflects a resolved value to Ok — args are forwarded positionally', async (assert) => {
    const scan = await AsyncResult.try(loadUser, 1, 'admin');
    assert.true(scan.ok);
    assert.deepEqual(scan.ok && scan.value, { id: 1, tag: 'admin' });
  });

  test('reflects a thrown Failure to Err (widened to Failure.Any)', async (assert) => {
    const scan = await AsyncResult.try(loadUser, 0, 'admin');
    assert.false(scan.ok);
    // Type is Result<_, Failure.Any>; a factory guard narrows it back at the branch.
    assert.true(!scan.ok && Boom.is(scan.error));
    if (scan.ok || !Boom.is(scan.error)) return;
    assert.equal(scan.error.data.at, 'loadUser(0)');
  });

  test('a non-Failure throw is a bug — it rejects, never becomes a tidy Err', async (assert) => {
    const buggy = () => Promise.reject(new TypeError('genuine bug'));
    await assert.rejects(AsyncResult.try(buggy), TypeError);
  });

  test('owning the call catches a SYNCHRONOUS throw too', async (assert) => {
    // This fn throws before it ever returns a promise. Passing a pre-made promise (#1) could
    // not catch this; owning the invocation (#2) does.
    const syncThrower = (): Promise<number> => {
      throw Boom({ at: 'sync' });
    };
    const scan = await AsyncResult.try(syncThrower);
    assert.true(!scan.ok && Boom.is(scan.error));
  });

  test('returns a chainable AsyncResult — .map/.andThen read left-to-right', async (assert) => {
    const name = await AsyncResult.try(loadUser, 2, 'dev')
      .map((u) => u.tag.toUpperCase())
      .andThen(
        (tag): Result<string, never> => ({ ok: true, value: `#${tag}` }) as Result<string, never>,
      );
    assert.deepEqual(name, { ok: true, value: '#DEV' });
  });

  test('a failure short-circuits the chain, still settling to a plain Result', async (assert) => {
    const out = await AsyncResult.try(loadUser, -1, 'x').map((u) => u.tag);
    assert.true(!out.ok && Boom.is(out.error));
  });
});
