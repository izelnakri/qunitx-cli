import { module, test } from 'qunitx';
import { Task, Failure } from '../../lib/task/index.ts';

const NotFound = Failure.define('NotFound', (data: { id: number }) => `no user ${data.id}`);

const loadUser = (id: number): Task<{ id: number; name: string }> =>
  Task.run(() => {
    if (!id) throw NotFound({ id });
    return { id, name: 'u' + id };
  });

// ── Lazy: the recipe runs only on await ─────────────────────────────────────────

module('Task | lazy', { concurrency: true }, () => {
  test('the recipe does not run until the Task is awaited', async (assert) => {
    let ran = false;
    const task = Task.run(() => {
      ran = true;
      return 1;
    });
    assert.false(ran, 'nothing ran at construction');
    await task;
    assert.true(ran, 'ran only on await');
  });

  test('a chain stays lazy — .map does not trigger the upstream Task', async (assert) => {
    let ran = false;
    const mapped = Task.run(() => {
      ran = true;
      return 2;
    }).map((x) => x + 1);
    assert.false(ran, 'building the chain ran nothing');
    assert.strictEqual(await mapped, 3);
    assert.true(ran, 'awaiting the chain ran it');
  });

  test('a memoria-style lazy relationship fires its RPC only on await', async (assert) => {
    let rpcCount = 0;
    const posts = () => Task.run(() => (rpcCount++, [{ id: 1 }, { id: 2 }]));
    const rel = posts();
    assert.strictEqual(rpcCount, 0, 'accessing the relationship fired no RPC');
    assert.deepEqual(await rel, [{ id: 1 }, { id: 2 }]);
    assert.strictEqual(rpcCount, 1, 'RPC fired exactly once, on await');
  });
});

// ── It is a real Promise ──────────────────────────────────────────────────────

module('Task | is a real Promise', { concurrency: true }, () => {
  test('a Task is instanceof Promise', (assert) => {
    assert.true(loadUser(1) instanceof Promise);
    assert.true(Task.of(1) instanceof Promise);
  });

  test('await returns the value, or throws the Failure — the JS standard', async (assert) => {
    assert.deepEqual(await loadUser(1), { id: 1, name: 'u1' });
    try {
      await loadUser(0);
      assert.true(false, 'should have thrown');
    } catch (error) {
      assert.true(NotFound.is(error));
      assert.strictEqual((error as Failure.Of<typeof NotFound>).data.id, 0);
    }
  });

  test('Promise.all fail-fasts and short-circuits', async (assert) => {
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

  test('Task.run and Task.try turn a thrown Failure into a rejection', async (assert) => {
    await assert.rejects(
      Task.run(() => {
        throw NotFound({ id: 3 });
      }),
      /no user 3/,
    );
    await assert.rejects(
      Task.try(() => JSON.parse('not json') as unknown),
      SyntaxError,
    );
  });

  test('Task.from lifts a plain promise', async (assert) => {
    assert.strictEqual(await Task.from(Promise.resolve(5)), 5);
  });
});

// ── Transforming — lazy, and each returns a Task ────────────────────────────────

module('Task | transforming', { concurrency: true }, () => {
  test('map transforms success and returns a chainable Task', async (assert) => {
    const chained = loadUser(1)
      .map((u) => u.name)
      .map((n) => n.toUpperCase());
    assert.true(chained instanceof Task, 'still a Task, so it keeps chaining');
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

// ── Retry / restart — the ember-concurrency model ───────────────────────────────

module('Task | retry & restart', { concurrency: true }, () => {
  test('retry re-runs the recipe until it succeeds', async (assert) => {
    let attempts = 0;
    const flaky = Task.run(() => {
      attempts++;
      if (attempts < 3) throw NotFound({ id: attempts });
      return 'ok@' + attempts;
    });
    assert.strictEqual(await flaky.retry(5), 'ok@3');
    assert.strictEqual(attempts, 3, 'ran the recipe three times');
  });

  test('retry gives up and rejects with the last failure after exhausting attempts', async (assert) => {
    let attempts = 0;
    const always = Task.run(() => {
      attempts++;
      throw NotFound({ id: attempts });
    });
    await assert.rejects(always.retry(2));
    assert.strictEqual(attempts, 3, 'initial + 2 retries');
  });

  test('restart runs a fresh execution of the same recipe', async (assert) => {
    let runs = 0;
    const task = Task.run(() => 'run#' + ++runs);
    assert.strictEqual(await task, 'run#1');
    assert.strictEqual(await task.restart(), 'run#2', 'a fresh, independent execution');
  });
});

// ── result — the one bridge to { ok, value, error } ─────────────────────────────

module('Task | result', { concurrency: true }, () => {
  test('result reflects a success to Ok', async (assert) => {
    const { ok, value, error } = await loadUser(1).result();
    assert.true(ok);
    assert.deepEqual(value, { id: 1, name: 'u1' });
    assert.strictEqual(error, undefined);
  });

  test('result reflects a declared Failure to Err — the { ok, value, error } ergonomics', async (assert) => {
    const { ok, value, error } = await loadUser(0).result();
    assert.false(ok);
    assert.strictEqual(value, undefined);
    assert.strictEqual(error?.code, 'NotFound');
  });

  test('result RE-THROWS a bug — a non-Failure rejection stays a bug', async (assert) => {
    const buggy = Task.run<number>(() => {
      const x = undefined as unknown as { n: number };
      return x.n;
    });
    await assert.rejects(buggy.result(), TypeError);
  });

  test('reflect is an alias of result', async (assert) => {
    const { ok } = await loadUser(1).reflect();
    assert.true(ok);
  });

  test('Task.result lifts and reflects any promise in one step', async (assert) => {
    assert.strictEqual((await Task.result(Promise.resolve(9))).value, 9);
    assert.strictEqual(
      (await Task.result(Promise.reject(NotFound({ id: 2 })))).error?.code,
      'NotFound',
    );
  });
});

// ── results — batch without losing successes ────────────────────────────────────

module('Task | results', { concurrency: true }, () => {
  test('results keeps every outcome, positionally', async (assert) => {
    const results = await Task.results([loadUser(1), loadUser(0), loadUser(3)]);
    assert.deepEqual(
      results.map((r) => (r.ok ? r.value.name : 'FAIL:' + r.error.code)),
      ['u1', 'FAIL:NotFound', 'u3'],
    );
  });

  test('a bug in one task rejects the whole batch (two-tier)', async (assert) => {
    const buggy = Task.run<{ id: number; name: string }>(() => {
      throw new TypeError('boom');
    });
    await assert.rejects(Task.results([loadUser(1), buggy]), TypeError);
  });
});
