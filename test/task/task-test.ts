import { module, test } from 'qunitx';
import { Task, Failure } from '../../lib/task/index.ts';

const NotFound = Failure.define('NotFound', (data: { id: number }) => `no user ${data.id}`);

const loadUser = (id: number): Task<{ id: number; name: string }> =>
  Task.run(() => {
    if (!id) throw NotFound({ id });
    return { id, name: 'u' + id };
  });

// ── It is a real Promise ──────────────────────────────────────────────────────

module('Task | is a real Promise', { concurrency: true }, () => {
  test('a Task is instanceof Promise', (assert) => {
    assert.true(loadUser(1) instanceof Promise);
    assert.true(Task.of(1) instanceof Promise);
  });

  test('await returns the value, or throws the Failure — idiomatic', async (assert) => {
    assert.deepEqual(await loadUser(1), { id: 1, name: 'u1' });
    try {
      await loadUser(0);
      assert.true(false, 'should have thrown');
    } catch (error) {
      assert.true(NotFound.is(error));
      assert.strictEqual((error as Failure.Of<typeof NotFound>).data.id, 0);
    }
  });

  test('Promise.all fail-fasts on the first failure and short-circuits', async (assert) => {
    assert.deepEqual(await Promise.all([loadUser(1), loadUser(2)]), [
      { id: 1, name: 'u1' },
      { id: 2, name: 'u2' },
    ]);
    await assert.rejects(Promise.all([loadUser(1), loadUser(0)]), /no user 0/);
  });
});

// ── Builders ──────────────────────────────────────────────────────────────────

module('Task | builders', { concurrency: true }, () => {
  test('Task.of succeeds, Task.fail fails', async (assert) => {
    assert.strictEqual(await Task.of(42), 42);
    await assert.rejects(Task.fail(NotFound({ id: 7 })), /no user 7/);
  });

  test('Task.run turns a thrown Failure into a rejection', async (assert) => {
    const settled = await Task.run(() => {
      throw NotFound({ id: 3 });
    }).settle();
    assert.false(settled.ok);
    assert.strictEqual(settled.error?.code, 'NotFound');
  });

  test('Task.from lifts a plain promise', async (assert) => {
    assert.strictEqual(await Task.from(Promise.resolve(5)), 5);
  });
});

// ── Transforming — thin over native ─────────────────────────────────────────────

module('Task | transforming', { concurrency: true }, () => {
  test('map transforms success and returns a Task', async (assert) => {
    const chained = loadUser(1)
      .map((u) => u.name)
      .map((n) => n.toUpperCase());
    assert.true(chained instanceof Task);
    assert.strictEqual(await chained, 'U1');
  });

  test('map passes a failure through untouched', async (assert) => {
    await assert.rejects(
      loadUser(0).map((u) => u.name),
      /no user 0/,
    );
  });

  test('mapErr transforms the failure reason', async (assert) => {
    const remapped = loadUser(0).mapErr((e) => new Error('wrapped: ' + (e as Failure.Any).code));
    await assert.rejects(remapped, /wrapped: NotFound/);
  });

  test('recover produces a success value from a failure', async (assert) => {
    assert.deepEqual(await loadUser(0).recover(() => ({ id: -1, name: 'guest' })), {
      id: -1,
      name: 'guest',
    });
  });

  test('expect rethrows a failure with a custom message and cause', async (assert) => {
    try {
      await loadUser(0).expect('a user is required here');
      assert.true(false, 'unreachable');
    } catch (error) {
      assert.strictEqual((error as Error).message, 'a user is required here');
      assert.true(NotFound.is((error as Error).cause));
    }
  });

  test('unwrapOr substitutes a fallback', async (assert) => {
    assert.deepEqual(await loadUser(0).unwrapOr({ id: 0, name: 'anon' }), { id: 0, name: 'anon' });
    assert.deepEqual(await loadUser(1).unwrapOr({ id: 0, name: 'anon' }), { id: 1, name: 'u1' });
  });

  test('match runs exactly the branch that applies', async (assert) => {
    const render = (id: number) =>
      loadUser(id).match({
        ok: (u) => `ok:${u.name}`,
        err: (e) => `err:${(e as Failure.Any).code}`,
      });
    assert.strictEqual(await render(1), 'ok:u1');
    assert.strictEqual(await render(0), 'err:NotFound');
  });
});

// ── settle — the one bridge to { ok, value, error } ─────────────────────────────

module('Task | settle', { concurrency: true }, () => {
  test('settle reflects a success to Ok', async (assert) => {
    const { ok, value, error } = await loadUser(1).settle();
    assert.true(ok);
    assert.deepEqual(value, { id: 1, name: 'u1' });
    assert.strictEqual(error, undefined);
  });

  test('settle reflects a declared Failure to Err — the { ok, value, error } ergonomics', async (assert) => {
    const { ok, value, error } = await loadUser(0).settle();
    assert.false(ok);
    assert.strictEqual(value, undefined);
    assert.strictEqual(error?.code, 'NotFound');
  });

  test('settle RE-THROWS a bug — a non-Failure rejection stays a bug', async (assert) => {
    const buggy = Task.run<number>(() => {
      const x = undefined as unknown as { n: number };
      return x.n;
    });
    await assert.rejects(buggy.settle(), TypeError);
  });

  test('Task.settle lifts and reflects any promise in one step', async (assert) => {
    const okr = await Task.settle(Promise.resolve(9));
    assert.strictEqual(okr.value, 9);
    const errr = await Task.settle(Promise.reject(NotFound({ id: 2 })));
    assert.strictEqual(errr.error?.code, 'NotFound');
  });
});

// ── settleAll — batch without losing successes ──────────────────────────────────

module('Task | settleAll', { concurrency: true }, () => {
  test('settleAll keeps every outcome, positionally', async (assert) => {
    const results = await Task.settleAll([loadUser(1), loadUser(0), loadUser(3)]);
    assert.deepEqual(
      results.map((r) => (r.ok ? r.value.name : 'FAIL:' + r.error.code)),
      ['u1', 'FAIL:NotFound', 'u3'],
    );
  });

  test('a bug in one task rejects the whole batch (two-tier)', async (assert) => {
    const buggy = Task.run<{ id: number; name: string }>(() => {
      throw new TypeError('boom');
    });
    await assert.rejects(Task.settleAll([loadUser(1), buggy]), TypeError);
  });
});
