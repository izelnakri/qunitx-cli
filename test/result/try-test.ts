import { module, test } from 'qunitx';
import * as Result from '../../lib/result/index.ts';
import { tryCatch, isErrno } from '../../lib/result/try.ts';

// ── The spelling ──────────────────────────────────────────────────────────────

module('Result | try | spelling', { concurrency: true }, () => {
  test('Result.try and tryCatch are the same function', (assert) => {
    // `try` alone is a reserved word, so the bare import is `tryCatch` — named for the one
    // keyword pair this boundary owns; the namespace spelling is `Result.try`. One
    // implementation, two legal names.
    assert.strictEqual(Result.try, tryCatch);
  });

  test('mirrors Promise.try: the arguments after fn are passed through to it', (assert) => {
    const outcome = Result.try((a: number, b: number, c: string) => `${a + b}${c}`, 1, 2, '!');
    assert.true(outcome.ok);
    assert.strictEqual(outcome.value, '3!');
  });

  test('a zero-arg thunk needs no arguments — the closure spelling still works', (assert) => {
    assert.strictEqual(Result.try(() => 7).value, 7);
  });
});

// ── Synchronous sources ───────────────────────────────────────────────────────

module('Result | try | sync', { concurrency: true }, () => {
  test('a return becomes Ok, synchronously — no promise in sight', (assert) => {
    const parsed = Result.try(JSON.parse, '{"n":1}');
    assert.true(parsed.ok);
    assert.deepEqual(parsed.value, { n: 1 });
  });

  test('a throw becomes Err — the SyntaxError lands in .error untouched', (assert) => {
    const parsed = Result.try(JSON.parse, 'not json');
    assert.false(parsed.ok);
    assert.true(parsed.error instanceof SyntaxError);
  });

  test('every throw is boxed — classification is the call site’s flat rethrow line', (assert) => {
    // The boundary catches everything (it is the raw edge, like Lua's pcall). The two-tier
    // discipline lives in the visible line that follows: rethrow what was not declared.
    const outcome = Result.try((): number => {
      throw new TypeError('a bug, not a SyntaxError');
    });
    assert.false(outcome.ok);
    assert.throws(() => {
      if (!outcome.ok && !(outcome.error instanceof SyntaxError)) throw outcome.error;
    }, TypeError);
  });

  test('non-Error throwables are boxed verbatim — strings, null, undefined', (assert) => {
    const throwing = (value: unknown) =>
      Result.try(() => {
        throw value;
      });
    assert.strictEqual(throwing('nope').error, 'nope');
    assert.strictEqual(throwing(null).error, null);
    const boxedUndefined = throwing(undefined);
    assert.false(boxedUndefined.ok, 'a thrown undefined is still a failure');
    assert.strictEqual(boxedUndefined.error, undefined);
  });

  test('returning a Failure does not flatten — a returned failure is a VALUE inside Ok', (assert) => {
    // The boundary reflects throw-vs-return only. A bare-union producer that RETURNS its
    // failure still lands on the ok side here — the box does not second-guess the value.
    const Inner = Result.Failure.define('Inner', 'inner failure as data');
    const nested = Result.try(() => Inner());
    assert.true(nested.ok, 'the outer try succeeded');
    assert.true(Result.Failure.is(nested.value), 'the returned failure is untouched, as data');
  });
});

// ── Asynchronous sources ──────────────────────────────────────────────────────

module('Result | try | async', { concurrency: true }, () => {
  test('a thenable return yields a Promise of a Result', async (assert) => {
    const outcome = Result.try((n: number) => Promise.resolve(n * 2), 21);
    assert.true(outcome instanceof Promise, 'async source, promise out');
    assert.deepEqual(await outcome, { ok: true, value: 42, error: undefined });
  });

  test('a rejection resolves to Err — the returned promise NEVER rejects', async (assert) => {
    const outcome = await Result.try(() => Promise.reject(new Error('boom')));
    assert.false(outcome.ok);
    assert.strictEqual((outcome.error as Error).message, 'boom');
  });

  test('the synchronous prefix of async work is inside the boundary too', (assert) => {
    // An async operation that throws before returning its promise — fetch on a malformed
    // URL is the canonical case — fails synchronously. Because Result.try owns the call,
    // that throw is boxed sync; wrapping a pre-started promise could never offer this.
    const outcome = Result.try((url: string): Promise<never> => {
      throw new TypeError(`Invalid URL: ${url}`);
    }, '::not-a-url');
    assert.false((outcome as Result.Result<never>).ok, 'boxed synchronously, not a rejection');
  });

  test('a foreign thenable takes the async path and is settled by the spec algorithm', async (assert) => {
    const thenable = {
      then(resolve: (v: string) => void) {
        resolve('from a hand-rolled thenable');
      },
    };
    const outcome = await Result.try(() => thenable as PromiseLike<string>);
    assert.strictEqual(outcome.value, 'from a hand-rolled thenable');
  });

  test('Promise.all over tries never fail-fasts, so no success is discarded', async (assert) => {
    const work = (n: number) =>
      Result.try(() => {
        if (n % 2 === 0) return Promise.reject(new Error(`even ${n}`));
        return Promise.resolve(n);
      });
    const results = await Promise.all([1, 2, 3, 4].map(work));
    // `Result.partition` discriminates by the Failure brand, so it cannot split the
    // boundary's boxes — the box/union seam is crossed by hand here. This is a cost the
    // bare-union style pays: the boundary's `{ ok, value, error }` and the declared-failure
    // union no longer share one vocabulary.
    const values = results.filter((r) => r.ok).map((r) => r.value);
    const errors = results.filter((r) => !r.ok).map((r) => r.error);
    assert.deepEqual(values, [1, 3]);
    assert.deepEqual(
      errors.map((e) => (e as Error).message),
      ['even 2', 'even 4'],
    );
  });
});

// ── isErrno — the flat-classification guard for Node system errors ───────────

module('Result | try | isErrno', { concurrency: true }, () => {
  const errnoError = (code: string) => Object.assign(new Error(code), { code });

  test('matches by Node code, so the rethrow line reads as the declaration', (assert) => {
    const outcome = Result.try(() => {
      throw errnoError('EEXIST');
    });
    assert.false(outcome.ok);
    assert.true(isErrno(outcome.error, 'EEXIST'));
    assert.false(isErrno(outcome.error, 'ENOENT'), 'the wrong code does not match');
  });

  test('with no codes it matches any error carrying a string code', (assert) => {
    assert.true(isErrno(errnoError('ANYTHING')));
    assert.true(isErrno(errnoError('ERR_MODULE_NOT_FOUND')), 'Node internal errors count too');
    assert.false(isErrno(new Error('no code at all')));
  });

  test('rejects non-Errors even when they look the part', (assert) => {
    assert.false(isErrno({ code: 'ENOENT', message: 'imposter' }));
    assert.false(isErrno('ENOENT'));
    assert.false(isErrno(null));
  });

  test('the canonical flat line: box, test, rethrow what was not declared', (assert) => {
    const link = (fail: string | null) =>
      Result.try(() => {
        if (fail) throw errnoError(fail);
        return 'linked';
      });

    const lost = link('EEXIST');
    if (!lost.ok && !isErrno(lost.error, 'EEXIST')) throw lost.error;
    assert.false(lost.ok, 'EEXIST was declared, so it flows as a value');

    const broken = link('ENOSPC');
    assert.throws(() => {
      if (!broken.ok && !isErrno(broken.error, 'EEXIST')) throw broken.error;
    }, /ENOSPC/);
  });
});

// ── rescue — the boundary and the declaration fused ──────────────────────────

module('Result | rescue', { concurrency: true }, () => {
  const BadInput = Result.Failure.define(
    'BadInput',
    (d: { hint: string }) => `bad input: ${d.hint}`,
  );

  test('a return comes back bare; a throw comes back as the declared failure', (assert) => {
    const parsed = Result.rescue(
      JSON.parse,
      (cause) => BadInput({ hint: 'json' }, { cause }),
      '{"n":1}',
    );
    assert.deepEqual(parsed, { n: 1 });
    const failed = Result.rescue(
      JSON.parse,
      (cause) => BadInput({ hint: 'json' }, { cause }),
      'nope',
    );
    assert.true(BadInput.is(failed));
    assert.true((failed as Result.Failure.Any).cause instanceof SyntaxError, 'original chained');
  });

  test('an async source resolves to the bare union and never rejects', async (assert) => {
    const ok = await Result.rescue(
      () => Promise.resolve(7),
      () => BadInput({ hint: 'io' }),
    );
    assert.strictEqual(ok, 7);
    const failed = await Result.rescue(
      () => Promise.reject(new Error('io down')),
      (cause) => BadInput({ hint: 'io' }, { cause }),
    );
    assert.true(BadInput.is(failed));
  });

  test('the synchronous prefix of async work is classified too', (assert) => {
    const failed = Result.rescue(
      (): Promise<never> => {
        throw new TypeError('sync throw before the promise');
      },
      (cause) => BadInput({ hint: 'sync' }, { cause }),
    );
    assert.true(BadInput.is(failed), 'classified synchronously, not a rejection');
  });
});
