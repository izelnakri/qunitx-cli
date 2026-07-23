import { module, test } from 'qunitx';
import * as Result from '../../lib/result/index.ts';

const { AsyncResult, asyncResult, ok, err } = Result;

const Denied = Result.Failure.define('Denied', 'permission denied');

// A producer: async work that settles to a plain Result, wrapped as an AsyncResult.
function load(
  fail: boolean,
): Result.AsyncResult<{ port: number }, Result.Failure.Of<typeof Denied>> {
  return asyncResult(
    new Promise((resolve) =>
      setTimeout(() => resolve(fail ? err(Denied()) : ok({ port: 3000 })), 1),
    ),
  );
}

// ── The invariant: await yields a PLAIN Result ────────────────────────────────

module('Result | AsyncResult | awaits to a plain Result', { concurrency: true }, () => {
  test('the awaited value is a plain object you branch on — not a thenable', async (assert) => {
    const r = await load(false);
    // This is the whole point: the settled value has `.ok`, survives JSON, and is NOT itself
    // awaitable. Only the producer (`load(...)`) was thenable.
    assert.true(r.ok);
    assert.deepEqual(r.value, { port: 3000 });
    assert.strictEqual(typeof (r as { then?: unknown }).then, 'undefined', 'r is not thenable');
    assert.strictEqual(JSON.stringify(r), '{"ok":true,"value":{"port":3000}}');
  });

  test('the failure branch is a value, exactly like the sync Result', async (assert) => {
    const r = await load(true);
    assert.false(r.ok);
    assert.strictEqual(r.error?.code, 'Denied');
  });

  test('the documented call site reads with no ceremony', async (assert) => {
    // const r = await Config.setup(); if (!r.ok) return handle(r.error); use(r.value);
    const r = await load(false);
    if (!r.ok) {
      assert.true(false, 'unreachable');
      return;
    }
    assert.strictEqual(r.value.port, 3000);
  });
});

// ── Chaining settles to a plain Result ────────────────────────────────────────

module('Result | AsyncResult | chaining', { concurrency: true }, () => {
  test('map transforms a success and still settles to a plain Result', async (assert) => {
    const r = await load(false).map((c) => ({ ...c, https: true }));
    assert.deepEqual(r.value, { port: 3000, https: true });
    assert.strictEqual(typeof (r as { then?: unknown }).then, 'undefined');
  });

  test('map leaves a failure untouched', async (assert) => {
    const r = await load(true).map((c) => ({ ...c, https: true }));
    assert.strictEqual(r.error?.code, 'Denied');
  });

  test('mapErr transforms a failure and leaves a success alone', async (assert) => {
    const mapped = await load(true).mapErr((e) => e.code.toUpperCase());
    assert.strictEqual(mapped.error, 'DENIED');
    const untouched = await load(false).mapErr(() => 'never');
    assert.true(untouched.ok);
  });

  test('andThen chains a second async step, short-circuiting on failure', async (assert) => {
    const check = (c: { port: number }) =>
      c.port > 0 ? AsyncResult.ok(`:${c.port}`) : AsyncResult.err(Denied());
    assert.strictEqual(Result.unwrap(await load(false).andThen(check)), ':3000');
    assert.false((await load(true).andThen(check)).ok);
  });

  test('andThen accepts a plain Result, an AsyncResult, or a Promise — all flatten', async (assert) => {
    const plain = await load(false).andThen((c) => ok(c.port));
    const nested = await load(false).andThen((c) => AsyncResult.ok(c.port));
    const promised = await load(false).andThen((c) => Promise.resolve(ok(c.port)));
    assert.deepEqual([plain.value, nested.value, promised.value], [3000, 3000, 3000]);
  });

  test('a whole chain reads left-to-right', async (assert) => {
    const r = await load(false)
      .map((c) => c.port)
      .andThen((port) => (port > 1024 ? AsyncResult.ok(port) : AsyncResult.err(Denied())))
      .map((port) => `listening on ${port}`);
    assert.strictEqual(Result.unwrap(r), 'listening on 3000');
  });
});

// ── Consuming ─────────────────────────────────────────────────────────────────

module('Result | AsyncResult | consuming', { concurrency: true }, () => {
  test('match runs exactly the branch that applies', async (assert) => {
    const shown = await load(false).match({
      ok: (c) => `ok:${c.port}`,
      err: (e) => `err:${e.code}`,
    });
    assert.strictEqual(shown, 'ok:3000');
  });

  test('unwrapOr substitutes a fallback on failure', async (assert) => {
    assert.deepEqual(await load(false).unwrapOr({ port: 0 }), { port: 3000 });
    assert.deepEqual(await load(true).unwrapOr({ port: 0 }), { port: 0 });
  });

  test('Promise.all keeps every result — an Err is a value, not a rejection', async (assert) => {
    // The batch property the sync Result gives up nothing to: no fail-fast, no lost successes.
    const batch = await Promise.all([load(false), load(true), load(false)]);
    const { values, errors } = Result.partition(batch);
    assert.strictEqual(values.length, 2);
    assert.strictEqual(errors.length, 1);
  });
});
