import { module, test } from 'qunitx';
import * as Result from '../../lib/result/index.ts';

const Denied = Result.Failure.define('Denied', 'permission denied');

// ── Declared failures ─────────────────────────────────────────────────────────

module('Result | attempt | declared failures', { concurrency: true }, () => {
  test('a success becomes Ok', (assert) => {
    const result = Result.attempt(() => JSON.parse('{"a":1}'), SyntaxError);
    assert.deepEqual(Result.unwrap(result), { a: 1 });
  });

  test('a declared throw becomes Err', (assert) => {
    const result = Result.attempt(() => JSON.parse('not json'), SyntaxError);
    assert.false(result.ok);
    assert.true(result.error instanceof SyntaxError);
  });

  test('an UNdeclared throw is rethrown, so bugs keep behaving like bugs', (assert) => {
    // The defining property of this design. A TypeError from broken code inside the boundary
    // must not become a tidy failure value that flows down the same path as a real outcome.
    assert.throws(
      () =>
        Result.attempt(() => {
          throw new TypeError('cannot read properties of undefined');
        }, SyntaxError),
      TypeError,
    );
  });

  test('with no matchers it is pcall: everything is caught', (assert) => {
    const result = Result.attempt(() => {
      throw new TypeError('anything');
    });
    assert.false(result.ok);
    assert.true(result.error instanceof TypeError);
  });

  test('several matchers widen the declared set', (assert) => {
    const run = (thrown: unknown) =>
      Result.attempt(
        () => {
          throw thrown;
        },
        SyntaxError,
        RangeError,
      );
    assert.false(run(new SyntaxError('a')).ok);
    assert.false(run(new RangeError('b')).ok);
    assert.throws(() => run(new TypeError('c')), TypeError);
  });

  test('a non-Error throwable is caught only when something declares it', (assert) => {
    const isString = (value: unknown): value is string => typeof value === 'string';
    const result = Result.attempt(() => {
      throw 'legacy library';
    }, isString);
    assert.strictEqual(result.error, 'legacy library');

    assert.throws(
      () =>
        Result.attempt(() => {
          throw 'legacy library';
        }, SyntaxError),
      /legacy library/,
    );
  });
});

// ── Matchers ──────────────────────────────────────────────────────────────────

module('Result | attempt | matchers', { concurrency: true }, () => {
  test('errno matches by Node code and rethrows the rest', (assert) => {
    const raise = (code: string) => () => {
      throw Object.assign(new Error(`${code}: failed`), { code });
    };
    assert.false(Result.attempt(raise('ENOENT'), Result.errno('ENOENT')).ok);
    assert.throws(() => Result.attempt(raise('EACCES'), Result.errno('ENOENT')), /EACCES/);
  });

  test('errno with no codes matches any error carrying a string code', (assert) => {
    const result = Result.attempt(() => {
      throw Object.assign(new Error('boom'), { code: 'EBUSY' });
    }, Result.errno());
    assert.strictEqual(result.error?.code, 'EBUSY');
  });

  test('a Failure factory is itself a matcher', (assert) => {
    const result = Result.attempt(() => {
      throw Denied();
    }, Denied);
    assert.strictEqual(result.error?.code, 'Denied');
  });

  test('instanceOf covers constructors that are not Error subclasses', (assert) => {
    class Sentinel {}
    const result = Result.attempt(() => {
      throw new Sentinel();
    }, Result.instanceOf(Sentinel));
    assert.true(result.error instanceof Sentinel);
  });

  test('anyOf composes a reusable failure set', (assert) => {
    const transient = Result.anyOf(Result.errno('EBUSY', 'EAGAIN'), Denied);
    assert.false(
      Result.attempt(() => {
        throw Denied();
      }, transient).ok,
    );
    assert.false(
      Result.attempt(() => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }, transient).ok,
    );
    assert.throws(
      () =>
        Result.attempt(() => {
          throw new Error('unrelated');
        }, transient),
      /unrelated/,
    );
  });
});

// ── Async ─────────────────────────────────────────────────────────────────────

module('Result | attempt | async', { concurrency: true }, () => {
  test('an async source yields a promise of a Result', async (assert) => {
    const result = await Result.attempt(async () => await Promise.resolve('value'));
    assert.strictEqual(Result.unwrap(result), 'value');
  });

  test('a declared rejection resolves to Err — the promise does not reject', async (assert) => {
    const result = await Result.attempt(async () => {
      await Promise.resolve();
      throw new SyntaxError('bad');
    }, SyntaxError);
    assert.true(result.error instanceof SyntaxError);
  });

  test('an undeclared rejection still rejects', async (assert) => {
    await assert.rejects(
      Result.attempt(async () => {
        await Promise.resolve();
        throw new TypeError('bug');
      }, SyntaxError),
      TypeError,
    );
  });

  test('a thunk also catches the synchronous part of async work', (assert) => {
    // `attempt(() => fetch(badUrl))` catches the TypeError fetch throws synchronously;
    // `attempt(fetch(badUrl))` cannot, because that throw happens while evaluating the
    // argument, outside the boundary. This is why the thunk form is the documented one.
    const result = Result.attempt(() => {
      throw new SyntaxError('thrown before any promise existed');
      // deno-lint-ignore no-unreachable
      return Promise.resolve(1);
    }, SyntaxError);
    assert.false((result as Result.Result<number, SyntaxError>).ok);
  });

  test('a promise may be passed directly when there is no sync part to guard', async (assert) => {
    const result = await Result.attempt(Promise.reject(new SyntaxError('bad')), SyntaxError);
    assert.true(result.error instanceof SyntaxError);
  });

  test('a foreign thenable takes the async path', async (assert) => {
    const thenable = { then: (resolve: (v: number) => void) => resolve(7) };
    assert.strictEqual(Result.unwrap(await Result.attempt(thenable)), 7);
  });

  test('Promise.all over attempts never fail-fasts, so no success is discarded', async (assert) => {
    // The property that makes batch work tractable: `Promise.all` rejects on the first
    // failure and throws away every settled success alongside it. These promises only ever
    // resolve, so `partition` sees the whole batch.
    const work = [1, 2, 3, 4].map((n) =>
      Result.attempt(async () => {
        await Promise.resolve();
        if (n % 2 === 0) throw Denied();
        return n;
      }, Denied),
    );
    const { values, errors } = Result.partition(await Promise.all(work));
    assert.deepEqual(values, [1, 3]);
    assert.strictEqual(errors.length, 2);
  });
});

// ── Lua parity ────────────────────────────────────────────────────────────────

module('Result | attempt | pcall/xpcall', { concurrency: true }, () => {
  test('pcall catches everything, exactly like Lua', (assert) => {
    const result = Result.pcall(() => {
      throw new TypeError('anything at all');
    });
    assert.true(result.error instanceof TypeError);
  });

  test('xpcall runs the handler on the way out', (assert) => {
    const result = Result.xpcall(
      () => {
        throw new Error('EACCES');
      },
      (thrown) => Denied(undefined, { cause: thrown }),
    );
    assert.strictEqual(result.error?.code, 'Denied');
    assert.strictEqual((result.error?.cause as Error).message, 'EACCES');
  });

  test('xpcall handles rejections too', async (assert) => {
    const result = await Result.xpcall(
      async () => {
        await Promise.resolve();
        throw new Error('EACCES');
      },
      (thrown) => Denied(undefined, { cause: thrown }),
    );
    assert.strictEqual(result.error?.code, 'Denied');
  });

  test('xpcall sees the snapshotted stack, not a live one', (assert) => {
    // Lua's message handler runs at the error point *before* unwinding, which is what makes
    // `xpcall(f, debug.traceback)` work. JavaScript has one-phase exception handling: by the
    // time a handler runs the stack is gone, and only what the Error captured survives.
    const result = Result.xpcall(
      () => {
        throw new Error('boom');
      },
      (thrown) => (thrown as Error).stack ?? '',
    );
    assert.true((result.error?.split('\n').length ?? 0) > 1, 'frames survive via the Error object');
  });
});
