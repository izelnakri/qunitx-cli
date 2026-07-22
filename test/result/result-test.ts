import { module, test } from 'qunitx';
import * as Result from '../../lib/result/index.ts';

// ── ok / err ──────────────────────────────────────────────────────────────────

module('Result | ok/err', { concurrency: true }, () => {
  test('ok(value) carries the value and reports success', (assert) => {
    const result = Result.ok(42);
    assert.true(result.ok);
    assert.strictEqual(result.value, 42);
    assert.strictEqual(result.error, undefined);
  });

  test('err(error) carries the error and reports failure', (assert) => {
    const boom = new Error('boom');
    const result = Result.err(boom);
    assert.false(result.ok);
    assert.strictEqual(result.error, boom);
    assert.strictEqual(result.value, undefined);
  });

  test('both variants share one key order, so `.ok` stays a monomorphic load', (assert) => {
    // The perf claim in result.ts is exactly this: same key set, same insertion order, so V8
    // assigns both constructors the same hidden class. If a refactor ever writes the natural
    // `{ ok: false, error }` instead, this is what notices.
    assert.deepEqual(Object.keys(Result.ok(1)), ['ok', 'value', 'error']);
    assert.deepEqual(Object.keys(Result.err(1)), ['ok', 'value', 'error']);
  });

  test('ok() with no argument returns a shared frozen singleton', (assert) => {
    assert.strictEqual(Result.ok(), Result.ok());
    assert.true(Object.isFrozen(Result.ok()));
  });

  test('ok(undefined) allocates rather than sharing the singleton', (assert) => {
    // Passing a variable that happens to hold undefined must not silently alias the frozen
    // singleton — callers who then compare Results by identity would get a wrong answer.
    assert.notStrictEqual(Result.ok(undefined), Result.ok());
  });

  test('err(undefined) is still a failure', (assert) => {
    // `throw undefined` is legal JS and does occur, so an undefined error must not be
    // mistaken for success by any code path.
    const result = Result.err(undefined);
    assert.false(result.ok);
    assert.true(Result.isErr(result));
  });
});

// ── Narrowing ─────────────────────────────────────────────────────────────────

module('Result | narrowing', { concurrency: true }, () => {
  test('a truthiness check on .ok narrows both branches', (assert) => {
    const result: Result.Result<number, string> = Result.ok(1);
    if (result.ok) {
      assert.strictEqual(result.value + 1, 2);
    } else {
      assert.true(false, 'unreachable');
    }
  });

  test('destructuring narrows too, so no intermediate variable is needed', (assert) => {
    // TypeScript 4.6+ narrows destructured discriminated unions. This is what lets the
    // object form compete with tuple destructuring on brevity without giving up narrowing.
    const { ok, value, error } = Result.err<string>('nope') as Result.Result<number, string>;
    if (ok) {
      assert.strictEqual(value, 0, 'unreachable');
    } else {
      assert.strictEqual(error.toUpperCase(), 'NOPE');
    }
  });

  test('isOk and isErr narrow when the check has to happen elsewhere', (assert) => {
    const results: Result.Result<number, string>[] = [Result.ok(1), Result.err('bad')];
    assert.deepEqual(
      results.filter(Result.isOk).map((r) => r.value),
      [1],
    );
    assert.deepEqual(
      results.filter(Result.isErr).map((r) => r.error),
      ['bad'],
    );
  });

  test('isResult recognises a Result that arrived as plain data', (assert) => {
    // The whole point of the plain-object representation: a Result survives JSON and is
    // still a Result on the other side. A class-based Result arrives as a shapeless object.
    const revived = JSON.parse(JSON.stringify(Result.ok({ id: 1 })));
    assert.true(Result.isResult(revived));
    assert.deepEqual(revived.value, { id: 1 });
  });

  test('isResult rejects lookalikes that are not Results', (assert) => {
    assert.false(Result.isResult(null));
    assert.false(Result.isResult({ ok: 'yes' }));
    assert.false(Result.isResult('ok'));
  });
});

// ── unwrap / expect ───────────────────────────────────────────────────────────

module('Result | unwrap', { concurrency: true }, () => {
  test('returns the value of a success', (assert) => {
    assert.strictEqual(Result.unwrap(Result.ok('x')), 'x');
  });

  test('rethrows an Error failure by identity, preserving its stack', (assert) => {
    const boom = new Error('boom');
    try {
      Result.unwrap(Result.err(boom));
      assert.true(false, 'should have thrown');
    } catch (error) {
      // Identity, not equality: the original stack still points at where `boom` was created
      // rather than at this unwrap. `expect()` is the opposite trade.
      assert.strictEqual(error, boom);
    }
  });

  test('wraps a non-Error failure so something with a stack always propagates', (assert) => {
    try {
      Result.unwrap(Result.err('just a string'));
      assert.true(false, 'should have thrown');
    } catch (error) {
      assert.true(error instanceof Error);
      assert.true((error as Error).message.includes('just a string'));
      assert.strictEqual((error as Error).cause, 'just a string');
    }
  });

  test('describes an unserializable failure instead of throwing while reporting it', (assert) => {
    // A circular object breaks JSON.stringify, and a null-prototype object breaks String().
    // Either one throwing here would replace the failure being reported with a different one.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.throws(() => Result.unwrap(Result.err(circular)), /unwrap\(\) on a failed Result/);
    assert.throws(() => Result.unwrap(Result.err(Object.create(null))), /unwrap\(\)/);
    assert.throws(() => Result.unwrap(Result.err(Symbol('s'))), /unwrap\(\)/);
  });

  test('expect() throws at the demand site and files the original under cause', (assert) => {
    const boom = new Error('boom');
    try {
      Result.expect(Result.err(boom), 'config must load');
      assert.true(false, 'should have thrown');
    } catch (error) {
      assert.strictEqual((error as Error).message, 'config must load');
      assert.strictEqual((error as Error).cause, boom);
    }
  });

  test('unwrapOr and unwrapOrElse substitute a fallback', (assert) => {
    assert.strictEqual(Result.unwrapOr(Result.err('e'), 'fallback'), 'fallback');
    assert.strictEqual(Result.unwrapOr(Result.ok('v'), 'fallback'), 'v');
    assert.strictEqual(
      Result.unwrapOrElse(Result.err('e'), (error) => `recovered from ${error}`),
      'recovered from e',
    );
  });

  test('match runs exactly the branch that applies', (assert) => {
    const render = (result: Result.Result<number, string>) =>
      Result.match(result, { ok: (n) => `got ${n}`, err: (e) => `failed: ${e}` });
    assert.strictEqual(render(Result.ok(3)), 'got 3');
    assert.strictEqual(render(Result.err('nope')), 'failed: nope');
  });
});

// ── Transformations ───────────────────────────────────────────────────────────

module('Result | transformations', { concurrency: true }, () => {
  test('map applies to successes and leaves failures alone', (assert) => {
    assert.strictEqual(Result.unwrap(Result.map(Result.ok(2), (n) => n * 3)), 6);
    const failure = Result.err('e');
    assert.strictEqual(
      Result.map(failure, () => 'never'),
      failure,
      'passed through by identity',
    );
  });

  test('mapErr applies to failures and leaves successes alone', (assert) => {
    const mapped = Result.mapErr(Result.err('e'), (e) => new Error(e));
    assert.true(mapped.error instanceof Error);
    const success = Result.ok(1);
    assert.strictEqual(
      Result.mapErr(success, () => 'never'),
      success,
    );
  });

  test('andThen short-circuits on the first failure', (assert) => {
    const parse = (raw: string): Result.Result<number, string> => {
      const n = Number(raw);
      return Number.isNaN(n) ? Result.err(`not a number: ${raw}`) : Result.ok(n);
    };
    assert.strictEqual(Result.unwrap(Result.andThen(Result.ok('7'), parse)), 7);
    assert.strictEqual(
      Result.andThen(parse('abc'), (n) => Result.ok(n)).error,
      'not a number: abc',
    );
  });
});

// ── Collections ───────────────────────────────────────────────────────────────

module('Result | collections', { concurrency: true }, () => {
  test('all collects every value when nothing failed', (assert) => {
    const collected = Result.all([Result.ok(1), Result.ok(2), Result.ok(3)]);
    assert.deepEqual(Result.unwrap(collected), [1, 2, 3]);
  });

  test('all returns the first failure and stops', (assert) => {
    const collected = Result.all([Result.ok(1), Result.err('first'), Result.err('second')]);
    assert.strictEqual(collected.error, 'first');
  });

  test('all on an empty array succeeds with an empty array', (assert) => {
    assert.deepEqual(Result.unwrap(Result.all([])), []);
  });

  test('partition keeps successes and failures together', (assert) => {
    // The shape Promise.all cannot give you: a rejected Promise.all discards the successes
    // that had already settled along with every failure but the first.
    const { values, errors } = Result.partition([
      Result.ok(1),
      Result.err('a'),
      Result.ok(2),
      Result.err('b'),
    ]);
    assert.deepEqual(values, [1, 2]);
    assert.deepEqual(errors, ['a', 'b']);
  });
});
