import { spawn } from 'node:child_process';
import { module, test } from 'qunitx';
import { Task, Failure } from '../../lib/task/index.ts';

const NotFound = Failure.define('NotFound', (data: { id: number }) => `no user ${data.id}`);

const loadUser = (id: number): Task<{ id: number; name: string }> =>
  Task(() => {
    if (!id) throw NotFound({ id });
    return { id, name: 'u' + id };
  });

// ── Lazy: the recipe runs only on await ─────────────────────────────────────────

module('Task | lazy', { concurrency: true }, () => {
  test('the recipe does not run until the Task is awaited', async (assert) => {
    let ran = false;
    const task = Task(() => {
      ran = true;
      return 1;
    });
    assert.false(ran, 'nothing ran at construction');
    await task;
    assert.true(ran, 'ran only on await');
  });

  test('a chain stays lazy — no combinator triggers the upstream Task', async (assert) => {
    let ran = false;
    const chain = Task(() => {
      ran = true;
      return 2;
    })
      .map((x) => x + 1)
      .expect('never fails here')
      .result();
    assert.false(ran, 'building the whole chain ran nothing');
    assert.strictEqual((await chain).value, 3);
    assert.true(ran, 'awaiting the chain ran it');
  });

  test('catch and finally trigger the recipe too — they route through then', async (assert) => {
    let ran = 0;
    await Task(() => ++ran).finally(() => {});
    assert.strictEqual(ran, 1, 'finally started the run');
    const caught = await Task<number>(() => {
      throw NotFound({ id: 1 });
    }).catch(() => -1);
    assert.strictEqual(caught, -1, 'catch started the run and observed the rejection');
  });

  test('a memoria-style lazy relationship fires its RPC only on await', async (assert) => {
    let rpcCount = 0;
    const posts = () => Task(() => (rpcCount++, [{ id: 1 }, { id: 2 }]));
    const rel = posts();
    assert.strictEqual(rpcCount, 0, 'accessing the relationship fired no RPC');
    assert.deepEqual(await rel, [{ id: 1 }, { id: 2 }]);
    assert.strictEqual(rpcCount, 1, 'RPC fired exactly once, on await');
  });

  test('a settled Task memoises — repeated awaits share one run', async (assert) => {
    let runs = 0;
    const task = Task(() => ++runs);
    assert.strictEqual(await task, 1);
    assert.strictEqual(await task, 1, 'second await sees the memoised value');
    assert.strictEqual(runs, 1);
  });

  test('derived Tasks share the upstream memo — one fetch, many derivations', async (assert) => {
    let fetches = 0;
    const user = Task(() => (fetches++, { id: 7, name: 'u7' }));
    const name = user.map((u) => u.name);
    const id = user.map((u) => u.id);
    assert.strictEqual(await name, 'u7');
    assert.strictEqual(await id, 7);
    assert.strictEqual(await user.result().then((r) => r.value?.id), 7);
    assert.strictEqual(fetches, 1, 'three consumers, one fetch');
  });
});

// ── Call-or-construct ─────────────────────────────────────────────────────────

module('Task | call form', { concurrency: true }, () => {
  test('Task(recipe) and new Task(recipe) build the same thing', async (assert) => {
    const called = Task(() => 1);
    const constructed = new Task(() => 2);
    assert.true(called instanceof Task, 'call form: instanceof Task');
    assert.true(constructed instanceof Task, 'new form: instanceof Task');
    assert.strictEqual(await called, 1);
    assert.strictEqual(await constructed, 2);
  });

  test('the runtime name stays Task, not the internal class binding', (assert) => {
    assert.strictEqual(Task.name, 'Task');
  });

  test('Task(promise) wraps an in-flight promise — observation deferred, Task API intact', async (assert) => {
    const task = Task(Promise.resolve(7));
    assert.true(task instanceof Task);
    assert.strictEqual(await task, 7);
    assert.strictEqual((await task.result()).value, 7);
  });

  test('new Task(promise) — the constructor takes the same union', async (assert) => {
    assert.strictEqual(await new Task(Promise.resolve(8)), 8);
  });
});

// ── ignore — deliberate non-handling, eager by design ────────────────────────

module('Task | ignore', { concurrency: true }, () => {
  test('swallows a declared failure and resolves undefined', async (assert) => {
    assert.strictEqual(await loadUser(0).ignore('cleanup that may fail'), undefined);
  });

  test('swallows a bug too — ignore declares the outcome has no consequence at all', async (assert) => {
    const buggy = Task<number>(() => {
      throw new TypeError('boom');
    });
    assert.strictEqual(await buggy.ignore('cleanup'), undefined);
  });

  test('passes a success through untouched', async (assert) => {
    assert.deepEqual(await loadUser(1).ignore('unused label'), { id: 1, name: 'u1' });
  });

  test('is EAGER — fire-and-forget starts the work with no await', (assert) => {
    let ran = false;
    Task(() => {
      ran = true;
      return 1;
    }).ignore('fire and forget');
    assert.true(ran, 'ignore started the recipe immediately, unlike every lazy method');
  });

  test('a fire-and-forget rejection is absorbed, never an unhandled rejection', async (assert) => {
    Task<number>(() => Promise.reject(NotFound({ id: 9 }))).ignore('cleanup');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.true(true, 'the runner would have flagged an unhandled rejection by now');
  });

  test('Task.ignore is the one-shot static spelling — same semantics, no intermediate', async (assert) => {
    assert.strictEqual(
      await Task.ignore(Promise.reject(NotFound({ id: 1 })), 'cleanup'),
      undefined,
    );
    assert.strictEqual(await Task.ignore(() => 5, 'unused label'), 5, 'success passes through');
  });

  test('ignored failures reach the Failure.onIgnored observer, from both spellings', async (assert) => {
    const seen: string[] = [];
    Failure.onIgnored((context) => seen.push(context));
    try {
      await loadUser(0).ignore('instance spelling');
      await Task.ignore(Promise.reject(NotFound({ id: 2 })), 'static spelling');
    } finally {
      Failure.onIgnored(null);
    }
    assert.true(seen.includes('instance spelling'));
    assert.true(seen.includes('static spelling'));
  });
});

// ── It is a real Promise ──────────────────────────────────────────────────────

module('Task | is a real Promise', { concurrency: true }, () => {
  test('a Task is instanceof Promise', (assert) => {
    assert.true(loadUser(1) instanceof Promise);
    assert.true(Task.resolve(1) instanceof Promise);
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

  test('Promise.all over Tasks fail-fasts', async (assert) => {
    assert.deepEqual(await Promise.all([loadUser(1), loadUser(2)]), [
      { id: 1, name: 'u1' },
      { id: 2, name: 'u2' },
    ]);
    await assert.rejects(Promise.all([loadUser(1), loadUser(0)]), /no user 0/);
  });

  test('then derives a plain Promise, not a Task — species is Promise', (assert) => {
    const derived = loadUser(1).then((u) => u.name);
    assert.true(derived instanceof Promise);
    assert.false(derived instanceof Task, 'a then-derived promise has no recipe to re-run');
  });
});

// ── perform — start now, join later ───────────────────────────────────────────

module('Task | perform', { concurrency: true }, () => {
  test('perform starts the run without suspending; await joins it', async (assert) => {
    const order: string[] = [];
    const task = Task(() => {
      order.push('recipe ran');
      return 42;
    });
    order.push('before perform');
    task.perform();
    order.push('after perform');
    assert.strictEqual(await task, 42);
    assert.deepEqual(order, ['before perform', 'recipe ran', 'after perform']);
  });

  test('perform is an idempotent join and returns this', async (assert) => {
    let runs = 0;
    const task = Task(() => ++runs);
    assert.strictEqual(task.perform(), task);
    assert.strictEqual(task.perform(), task, 'second perform is a no-op join');
    assert.strictEqual(await task, 1);
    assert.strictEqual(runs, 1);
  });
});

// ── Builders ──────────────────────────────────────────────────────────────────

module('Task | builders', { concurrency: true }, () => {
  test('Task.resolve succeeds, Task.fail fails with a typed reason', async (assert) => {
    assert.strictEqual(await Task.resolve(42), 42);
    await assert.rejects(Task.fail(NotFound({ id: 7 })), /no user 7/);
  });

  test('Task.from lifts a promise or a recipe', async (assert) => {
    assert.strictEqual(await Task.from(Promise.resolve(5)), 5);
    assert.strictEqual(await Task.from(() => 6), 6);
  });

  test('Task.try carries arguments and stays lazy — Promise.try made lazy', async (assert) => {
    let ran = false;
    const task = Task.try(
      (a: number, b: number) => {
        ran = true;
        return a + b;
      },
      20,
      22,
    );
    assert.false(ran, 'nothing ran at Task.try time');
    assert.strictEqual(await task, 42);
  });

  test('Task.try boxes a synchronous throw as the rejection', async (assert) => {
    await assert.rejects(
      Task.try(() => JSON.parse('not json') as unknown),
      SyntaxError,
    );
  });

  test('Task.withResolvers settles from outside — resolve may land before the first await', async (assert) => {
    const { promise, resolve } = Task.withResolvers<string>();
    resolve('early');
    assert.strictEqual(await promise, 'early');

    const failing = Task.withResolvers<string>();
    failing.reject(NotFound({ id: 3 }));
    await assert.rejects(failing.promise, /no user 3/);
  });
});

// ── Combinators — lazy versions of the Promise statics ───────────────────────

module('Task | combinators', { concurrency: true }, () => {
  test('Task.all is lazy and resolves positionally', async (assert) => {
    let runs = 0;
    const all = Task.all([Task(() => ++runs && 'a'), Task(() => ++runs && 'b')]);
    assert.strictEqual(runs, 0, 'nothing ran at combination time');
    assert.deepEqual(await all, ['a', 'b']);
    assert.strictEqual(runs, 2);
  });

  test('Task.all fail-fasts on the first rejection, like Promise.all', async (assert) => {
    await assert.rejects(Task.all([loadUser(1), loadUser(0)]), /no user 0/);
  });

  test('Task.race and Task.any pick a settlement without losing laziness', async (assert) => {
    const fast = Task(() => 'fast');
    const never = Task<string>(() => new Promise<never>(() => {}));
    assert.strictEqual(await Task.race([fast, never]), 'fast');
    assert.strictEqual(await Task.any([Task.fail(NotFound({ id: 1 })), Task(() => 'ok')]), 'ok');
  });

  test('Task.allSettled keeps the spec shape', async (assert) => {
    const settled = await Task.allSettled([loadUser(1), loadUser(0)]);
    assert.deepEqual(
      settled.map((s) => s.status),
      ['fulfilled', 'rejected'],
    );
  });

  test('Task.results keeps every outcome, positionally, with typed errors', async (assert) => {
    const results = await Task.results([loadUser(1), loadUser(0), loadUser(3)]);
    assert.deepEqual(
      results.map((r) => (r.ok ? r.value.name : 'FAIL:' + r.error.code)),
      ['u1', 'FAIL:NotFound', 'u3'],
    );
  });

  test('a bug in one task rejects the whole Task.results batch (two-tier)', async (assert) => {
    const buggy = Task<{ id: number; name: string }>(() => {
      throw new TypeError('boom');
    });
    await assert.rejects(Task.results([loadUser(1), buggy]), TypeError);
  });

  test('combinators snapshot a one-shot iterable — restart() re-awaits the same members', async (assert) => {
    function* gen() {
      yield Task(() => 1);
      yield Task(() => 2);
    }
    const all = Task.all(gen());
    assert.deepEqual(await all, [1, 2]);
    // Without the snapshot, restart() re-iterates the exhausted generator and resolves [].
    assert.deepEqual(await all.restart(), [1, 2]);
    assert.deepEqual(await Task.results(gen()).restart(), [
      { ok: true, value: 1, error: undefined },
      { ok: true, value: 2, error: undefined },
    ]);
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

  test('map flattens a returned promise, so it is andThen too', async (assert) => {
    assert.strictEqual(await loadUser(1).map((u) => Promise.resolve(u.id * 10)), 10);
  });

  test('map passes a failure through untouched', async (assert) => {
    await assert.rejects(
      loadUser(0).map((u) => u.name),
      /no user 0/,
    );
  });

  test('mapErr is the adapter edge: it sees and remaps EVERY rejection', async (assert) => {
    const Classified = Failure.define('Classified', (d: { kind: string }) => `kind: ${d.kind}`);
    const remapFailure = loadUser(0).mapErr((e) =>
      Classified({ kind: (e as Failure.Any).code }, { cause: e }),
    );
    await assert.rejects(remapFailure, /kind: NotFound/);

    // A raw TypeError — foreign to the taxonomy — is exactly what mapErr exists to classify.
    const remapBug = Task(() => {
      throw new TypeError('socket reset');
    }).mapErr((e) => Classified({ kind: (e as Error).name }, { cause: e }));
    await assert.rejects(remapBug, /kind: TypeError/);
  });

  test('recover is the crash boundary: it catches declared failures AND bugs', async (assert) => {
    assert.deepEqual(await loadUser(0).recover(() => ({ id: -1, name: 'guest' })), {
      id: -1,
      name: 'guest',
    });
    const fromBug = await Task<string>(() => {
      throw new TypeError('boom');
    }).recover((e) => `recovered: ${(e as Error).name}`);
    assert.strictEqual(fromBug, 'recovered: TypeError');
  });
});

// ── The two-tier rule on every consuming method ───────────────────────────────

module('Task | two-tier', { concurrency: true }, () => {
  const buggy = () =>
    Task<{ id: number; name: string }>(() => {
      const x = undefined as unknown as { n: number };
      return { id: x.n, name: 'never' }; // TypeError: reading n of undefined — a bug
    });

  test('expect adds context to a declared failure, preserving code and data', async (assert) => {
    try {
      await loadUser(0).expect('the run needs a user here');
      assert.true(false, 'unreachable');
    } catch (error) {
      assert.true(NotFound.is(error), 'same code — every switch on it still works');
      const failure = error as Failure.Of<typeof NotFound>;
      assert.strictEqual(failure.message, 'the run needs a user here');
      assert.deepEqual(failure.data, { id: 0 }, 'data rides along');
      assert.true(NotFound.is(failure.cause), 'the original failure chains under cause');
    }
  });

  test('expect lets a bug pass through uncontextualised', async (assert) => {
    await assert.rejects(buggy().expect('context that must NOT wrap a bug'), TypeError);
  });

  test('unwrapOr substitutes only for declared failures; a bug still rejects', async (assert) => {
    assert.deepEqual(await loadUser(0).unwrapOr({ id: 0, name: 'anon' }), { id: 0, name: 'anon' });
    assert.deepEqual(await loadUser(1).unwrapOr({ id: 0, name: 'anon' }), { id: 1, name: 'u1' });
    await assert.rejects(buggy().unwrapOr({ id: 0, name: 'anon' }), TypeError);
  });

  test('match handles the declared branches; a bug belongs to neither', async (assert) => {
    const render = (id: number) =>
      loadUser(id).match({
        ok: (u) => `ok:${u.name}`,
        err: (e) => `err:${e.code}`,
      });
    assert.strictEqual(await render(1), 'ok:u1');
    assert.strictEqual(await render(0), 'err:NotFound');
    await assert.rejects(buggy().match({ ok: () => 'ok', err: () => 'err' }), TypeError);
  });

  test('result reflects Ok / Err and RE-THROWS a bug', async (assert) => {
    const success = await loadUser(1).result();
    assert.true(success.ok);
    assert.deepEqual(success.value, { id: 1, name: 'u1' });
    assert.strictEqual(success.error, undefined);

    const { ok, value, error } = await loadUser(0).result();
    assert.false(ok);
    assert.strictEqual(value, undefined);
    assert.strictEqual(error?.code, 'NotFound');

    await assert.rejects(buggy().result(), TypeError);
  });
});

// ── Retry / restart — fresh executions of the whole chain ─────────────────────

module('Task | retry & restart', { concurrency: true }, () => {
  test('restart runs a fresh execution of the same recipe', async (assert) => {
    let runs = 0;
    const task = Task(() => 'run#' + ++runs);
    assert.strictEqual(await task, 'run#1');
    assert.strictEqual(await task.restart(), 'run#2', 'a fresh, independent execution');
    assert.strictEqual(await task, 'run#1', 'the original stays memoised');
  });

  test('restart on a DERIVED task re-executes the whole chain, source included', async (assert) => {
    // The subtlety that shaped the lineage design: without it, a derived task's restart
    // re-ran only the derivation and served the source from its memo.
    let fetches = 0;
    const user = Task(() => ({ id: 7, name: 'u' + ++fetches }));
    const chain = user.map((u) => u.name).expect('user must load');
    assert.strictEqual(await chain, 'u1');
    assert.strictEqual(fetches, 1);
    assert.strictEqual(await chain.restart(), 'u2', 'the fetch itself re-ran');
    assert.strictEqual(fetches, 2);
    assert.strictEqual(await chain, 'u1', 'the original chain still serves its memo');
  });

  test('result() carries lineage too — restart re-runs and re-reflects', async (assert) => {
    let attempts = 0;
    const reflected = Task(() => {
      attempts++;
      if (attempts === 1) throw NotFound({ id: attempts });
      return 'ok@' + attempts;
    }).result();
    assert.false((await reflected).ok, 'first run failed');
    const second = await reflected.restart();
    assert.strictEqual(second.value, 'ok@2', 'restart re-ran the source, not the reflection');
  });

  test('retry() defaults to one fresh re-run after the first failure', async (assert) => {
    let attempts = 0;
    const flaky = Task(() => {
      attempts++;
      if (attempts < 2) throw NotFound({ id: attempts });
      return 'ok@' + attempts;
    });
    assert.strictEqual(await flaky.retry(), 'ok@2');
    assert.strictEqual(attempts, 2, 'initial + 1 retry');
  });

  test('retry(times) re-runs the whole chain per attempt until it succeeds', async (assert) => {
    let gitCalls = 0;
    const scan = Task(() => {
      gitCalls++;
      if (gitCalls < 3) throw new Error('index.lock contention');
      return 'clean';
    })
      .mapErr((cause) => NotFound({ id: gitCalls }, { cause }))
      .map((s) => s.toUpperCase());
    assert.strictEqual(await scan.retry(5), 'CLEAN');
    assert.strictEqual(gitCalls, 3, 'the source ran fresh on every attempt');
  });

  test('retry gives up after exhausting attempts and rejects with the last reason', async (assert) => {
    let attempts = 0;
    const always = Task(() => {
      attempts++;
      throw NotFound({ id: attempts });
    });
    await assert.rejects(always.retry(2), /no user 3/);
    assert.strictEqual(attempts, 3, 'initial + 2 retries');
  });

  test('a Task that already ran and failed retries cleanly — attempts are always fresh', async (assert) => {
    let attempts = 0;
    const flaky = Task(() => {
      attempts++;
      if (attempts < 2) throw NotFound({ id: attempts });
      return attempts;
    });
    await assert.rejects(flaky, /no user 1/);
    assert.strictEqual(await flaky.retry(1), 2, 'retry never serves the failed memo');
  });
});

// ── Data-first statics — the twin law: Task.m(t, …) ≡ t.m(…) ─────────────────

module('Task | data-first statics', { concurrency: true }, () => {
  test('map / mapErr / recover / expect delegate exactly', async (assert) => {
    assert.strictEqual(await Task.map(loadUser(1), (u) => u.name), 'u1');
    await assert.rejects(
      Task.mapErr(loadUser(0), (e) => new RangeError('twin: ' + (e as Failure.Any).code)),
      /twin: NotFound/,
    );
    assert.deepEqual(await Task.recover(loadUser(0), () => ({ id: -1, name: 'guest' })), {
      id: -1,
      name: 'guest',
    });
    try {
      await Task.expect(loadUser(0), 'twin context');
      assert.true(false, 'unreachable');
    } catch (error) {
      assert.strictEqual((error as Error).message, 'twin context');
      assert.true(NotFound.is(error), 'code preserved through the static twin');
    }
  });

  test('unwrapOr / match / result delegate, two-tier rules intact', async (assert) => {
    assert.deepEqual(await Task.unwrapOr(loadUser(0), { id: 0, name: 'anon' }), {
      id: 0,
      name: 'anon',
    });
    assert.strictEqual(
      await Task.match(loadUser(1), { ok: (u) => u.name, err: (e) => e.code }),
      'u1',
    );
    const { ok, error } = await Task.result(loadUser(0));
    assert.false(ok);
    assert.strictEqual(error?.code, 'NotFound');
  });

  test('perform / restart / retry delegate — lineage stays deep', async (assert) => {
    let runs = 0;
    const source = Task(() => 'run#' + ++runs);
    const chain = source.map((s) => s.toUpperCase());
    assert.strictEqual(await Task.perform(chain), 'RUN#1');
    assert.strictEqual(await Task.restart(chain), 'RUN#2', 'static restart re-ran the source');
    let attempts = 0;
    const flaky = Task(() => {
      attempts++;
      if (attempts < 3) throw NotFound({ id: attempts });
      return attempts;
    });
    assert.strictEqual(await Task.retry(flaky, 5), 3, 'static retry spawns fresh executions');
  });
});

// ── The loud default: an unconsumed rejection crashes, and says what broke ────

module('Task | unconsumed rejection', { concurrency: true }, () => {
  test('a performed-but-unconsumed failing Task crashes the process with the Failure visible', async (assert) => {
    // The real UX, in a real child process: no handler anywhere → the runtime's
    // unhandled-rejection default kills the process, and because the reason is a Failure
    // (a real Error with name/message/code/data/cause), the crash names the culprit.
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno — the node lane owns this child-process assert');
      return;
    }
    const entry = new URL('../../lib/task/index.ts', import.meta.url).href;
    const script =
      `import(${JSON.stringify(entry)}).then(({ Task, Failure }) => {` +
      `const NotFound = Failure.define('NotFound', (d) => 'no user ' + d.id);` +
      `Task(() => { throw NotFound({ id: 9 }); }).perform();` +
      `});`;
    const child = spawn(process.execPath, ['-e', script]);
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.notStrictEqual(code, 0, 'the process died — loud, not silent');
    assert.true(stderr.includes('Failure(NotFound)'), 'the crash names the failure code');
    assert.true(stderr.includes('no user 9'), 'and carries the interpolated message');
    assert.true(stderr.includes('id: 9'), 'and the structured data payload');
  });

  test('an unstarted Task cannot crash — laziness means dropped chains are dead code', async (assert) => {
    Task(() => {
      throw NotFound({ id: 1 });
    }); // never awaited, never performed: the recipe NEVER runs, so nothing can reject
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.true(true, 'no rejection existed to go unhandled');
  });
});

// ── The observation seam — consumers report classified failures ────────────────

module('Task | failure observation seam', () => {
  const collect = () => {
    const seen: string[] = [];
    Failure.onObserved((failure) => seen.push(failure.code));
    return seen;
  };

  test('result, match, unwrapOr and recover each report the declared failure once', async (assert) => {
    const seen = collect();
    try {
      await loadUser(0).result();
      await loadUser(0).match({ ok: () => 'ok', err: (e) => e.code });
      await loadUser(0).unwrapOr(null);
      await loadUser(0).recover(() => null);
      assert.deepEqual(seen, ['NotFound', 'NotFound', 'NotFound', 'NotFound']);
    } finally {
      Failure.onObserved(null);
    }
  });

  test('bugs never reach the seam — not even through recover, which survives them', async (assert) => {
    const seen = collect();
    try {
      const buggy = () =>
        Task<string>(() => {
          throw new TypeError('boom');
        });
      await buggy().recover(() => 'survived');
      await buggy()
        .result()
        .catch(() => 'rethrown as expected');
      assert.deepEqual(seen, [], 'the two tiers stay separate in tracing too');
    } finally {
      Failure.onObserved(null);
    }
  });

  test('a memoised consumer reports once, however many times it is awaited', async (assert) => {
    const seen = collect();
    try {
      const reflected = loadUser(0).result();
      await reflected;
      await reflected;
      assert.deepEqual(seen, ['NotFound'], 'memoisation covers the seam too');
    } finally {
      Failure.onObserved(null);
    }
  });
});
