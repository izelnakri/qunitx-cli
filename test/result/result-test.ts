import { module, test } from 'qunitx';
import * as Result from '../../lib/result/index.ts';
import * as Failure from '../../lib/result/failure.ts';
import { Task } from '../../lib/task/index.ts';

const NotFound = Failure.define('NotFound', (d: { id: number }) => `no user ${d.id}`);
const Denied = Failure.define('Denied', (d: { user: string }) => `denied: ${d.user}`);

// ── The bare union ────────────────────────────────────────────────────────────

module('Result | the bare union', { concurrency: true }, () => {
  test('a success is the value itself — nothing to unwrap on the happy path', (assert) => {
    const outcome: Result.Result<number, Failure.Of<typeof NotFound>> = 42;
    assert.strictEqual(outcome, 42);
  });

  test('a failure is the Failure itself — Failure.is discriminates', (assert) => {
    const outcome: Result.Result<number, Failure.Of<typeof NotFound>> = NotFound({ id: 7 });
    assert.true(Failure.is(outcome));
    if (Failure.is(outcome)) {
      assert.strictEqual(outcome.code, 'NotFound');
      assert.strictEqual(outcome.data.id, 7);
    }
  });

  test('narrowing works on both branches of an if', (assert) => {
    const parse = (raw: string): Result.Result<number, Failure.Of<typeof NotFound>> =>
      /^\d+$/.test(raw) ? Number(raw) : NotFound({ id: -1 });
    const outcome = parse('8080');
    if (Failure.is(outcome)) {
      assert.true(false, 'unreachable');
    } else {
      assert.strictEqual(outcome + 1, 8081); // narrowed to number
    }
  });

  test('a factory guard narrows to the exact failure kind', (assert) => {
    const outcome: Result.Result<string, Failure.Any> = Denied({ user: 'root' });
    assert.true(Denied.is(outcome));
    assert.false(NotFound.is(outcome));
  });

  test('the known trap, pinned: a success type that IS a Failure is indistinguishable', (assert) => {
    // The one rule of the union style — documented in result.ts — is that T must never
    // itself be a Failure. This pins the failure mode so its existence stays visible: a
    // function that fetches failures as *data* cannot use the bare union.
    const fetchedAsData: Result.Result<Failure.Any, Failure.Any> = NotFound({ id: 1 });
    assert.true(Failure.is(fetchedAsData), 'the fetched value tests as the failure channel');
  });
});

// ── unwrap / expect / unwrapOr ────────────────────────────────────────────────

module(
  'Result | unwrap — leave the union, keep the failure declared',
  { concurrency: true },
  () => {
    test('returns a success value untouched', (assert) => {
      assert.strictEqual(Result.unwrap('x' as Result.Result<string, Failure.Any>), 'x');
    });

    test('throws a failure by identity, preserving its stack', (assert) => {
      const boom = NotFound({ id: 3 });
      try {
        Result.unwrap(boom as Result.Result<string, Failure.Of<typeof NotFound>>);
        assert.true(false, 'should have thrown');
      } catch (error) {
        // Identity, not equality: the stack still points at where `boom` was created rather
        // than at this unwrap. `expect()` is the opposite trade.
        assert.strictEqual(error, boom);
      }
    });

    test('a thrown failure stays DECLARED, so a boundary upstream can still absorb it', async (assert) => {
      // What "keeps the failure declared" buys the caller: unwrap is for propagating a failure
      // that someone above still has a right to handle.
      const outcome = await Task(() =>
        Result.unwrap(NotFound({ id: 3 }) as Result.Result<string, Failure.Any>),
      ).result();
      assert.true(
        Failure.is(outcome) && outcome.code === 'NotFound',
        'result() handed it back as a value',
      );

      const substituted = await Task(() =>
        Result.unwrap(NotFound({ id: 3 }) as Result.Result<string, Failure.Any>),
      ).unwrapOr('fallback');
      assert.strictEqual(substituted, 'fallback', 'and unwrapOr could substitute for it');
    });
  },
);

module('Result | expect — promote a failure to a bug, permanently', { concurrency: true }, () => {
  test('returns a success value untouched', (assert) => {
    assert.strictEqual(Result.expect('x' as Result.Result<string, Failure.Any>, 'must load'), 'x');
  });

  test('throws at the demand site and files the original under cause', (assert) => {
    // The trade against unwrap: a fresh error whose stack points HERE, at the code that
    // demanded a value, with the original failure (and its own stack) kept under `cause`.
    const boom = NotFound({ id: 9 });
    try {
      Result.expect(boom as Result.Result<string, Failure.Of<typeof NotFound>>, 'must load');
      assert.true(false, 'should have thrown');
    } catch (error) {
      assert.strictEqual((error as Error).message, 'must load');
      assert.strictEqual((error as Error).cause, boom);
    }
  });

  test('throws a plain Error, never a Failure', (assert) => {
    try {
      Result.expect(NotFound({ id: 2 }) as Result.Result<number, Failure.Any>, 'promoted');
      assert.true(false, 'should have thrown');
    } catch (error) {
      assert.false(Failure.is(error), 'not a Failure');
    }
  });

  test('and THAT is what stops a boundary upstream from un-crashing it', async (assert) => {
    // The reason for the plain Error, stated as behaviour rather than as a comment: every
    // two-tier consumer treats a thrown Failure as declared and hands it onward as a value.
    // Were expect to throw one, the promotion it just performed would be quietly undone.
    const promoted = Task(() =>
      Result.expect(NotFound({ id: 4 }) as Result.Result<string, Failure.Any>, 'must load'),
    );
    await assert.rejects(promoted.result(), 'result() rethrows it — a bug is not an outcome');

    const stillCrashes = Task(() =>
      Result.expect(NotFound({ id: 4 }) as Result.Result<string, Failure.Any>, 'must load'),
    ).unwrapOr('fallback');
    await assert.rejects(stillCrashes, 'and no fallback can absorb it either');
  });

  test('unwrapOr substitutes a fallback for a failure only', (assert) => {
    assert.strictEqual(
      Result.unwrapOr(NotFound({ id: 1 }) as Result.Result<string, Failure.Any>, 'fallback'),
      'fallback',
    );
    assert.strictEqual(Result.unwrapOr('v' as Result.Result<string, Failure.Any>, 'fallback'), 'v');
  });
});

// ── Collections ───────────────────────────────────────────────────────────────

module('Result | collections', { concurrency: true }, () => {
  test('all collects every value when nothing failed', (assert) => {
    const outcomes: Result.Result<number, Failure.Any>[] = [1, 2, 3];
    assert.deepEqual(Result.all(outcomes), [1, 2, 3]);
  });

  test('all returns the first failure, bare, and stops', (assert) => {
    const first = NotFound({ id: 1 });
    const outcomes: Result.Result<number, Failure.Any>[] = [1, first, NotFound({ id: 2 })];
    assert.strictEqual(Result.all(outcomes), first);
  });

  test('all on an empty array succeeds with an empty array', (assert) => {
    assert.deepEqual(Result.all([]), []);
  });

  test('partition keeps successes and failures together', (assert) => {
    // The shape Promise.all cannot give you: a rejected Promise.all discards the successes
    // that had already settled along with every failure but the first.
    const a = NotFound({ id: 1 });
    const b = Denied({ user: 'x' });
    const { values, errors } = Result.partition([1, a, 2, b] as Result.Result<
      number,
      Failure.Any
    >[]);
    assert.deepEqual(values, [1, 2]);
    assert.deepEqual(errors, [a, b]);
  });
});
