import { spawn } from 'node:child_process';
import { module, test } from 'qunitx';
import { Task, Failure, AwaitTimeout, Shutdown } from '../../lib/task/index.ts';

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
      .context('never fails here')
      .result();
    assert.false(ran, 'building the whole chain ran nothing');
    assert.strictEqual(await chain, 3, '.result() settles to the bare value');
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
    const posts = () =>
      Task(() => {
        rpcCount++;
        return [{ id: 1 }, { id: 2 }];
      });
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
    const user = Task(() => {
      fetches++;
      return { id: 7, name: 'u7' };
    });
    const name = user.map((u) => u.name);
    const id = user.map((u) => u.id);
    assert.strictEqual(await name, 'u7');
    assert.strictEqual(await id, 7);
    assert.strictEqual(await user.result().then((r) => (Failure.is(r) ? undefined : r.id)), 7);
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
    assert.strictEqual(await task.result(), 7, 'the bare union is the value itself on success');
  });

  test('new Task(promise) — the constructor takes the same union', async (assert) => {
    assert.strictEqual(await new Task(Promise.resolve(8)), 8);
  });
});

// ── Construction forms — every shape work arrives in, with and without `new` ──
//
// One constructor takes all three: a recipe (no parameters), an executor (the `new Promise`
// shape, told apart by declared arity), and an already-running promise. These tests pin the
// dispatch rule, because it is the one thing a caller can get wrong silently.

// Polls until `condition` holds — waiting for the state a step depends on rather than
// sleeping for a duration that may or may not be enough.
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

module('Task | construction forms', { concurrency: true }, () => {
  // The cleanup idiom depends on this: `Task(handle?.close())` is `Task(undefined)` when the
  // handle is already gone, and an absent handle is not an error.
  test('null and undefined settle as-is, having run nothing', async (assert) => {
    assert.strictEqual(await Task(undefined), undefined);
    assert.strictEqual(await Task(null), null);

    const slot: { page: { close(): Promise<string> } | null } = { page: null };
    assert.strictEqual(await Task(slot.page?.close()).ignore('absent handle'), undefined);

    slot.page = { close: () => Promise.resolve('closed') };
    assert.strictEqual(await Task(slot.page?.close()).ignore('present handle'), 'closed');
  });

  // Why the call form is the one to reach for on a cleanup: both forms swallow the benign
  // runtime failure, but only the call form lets a SYNC throw — which for an async API means
  // the method is gone — reach someone. `ignore` should hide an ECONNRESET, not an upgrade.
  test('the call form keeps a sync throw visible while still absorbing a rejection', async (assert) => {
    const rejecting = { close: () => Promise.reject(new Error('ECONNRESET')) };
    assert.strictEqual(
      await Task(rejecting.close()).ignore('benign'),
      undefined,
      'a rejection is still absorbed',
    );

    const brokenApi = {
      close: (): Promise<void> => {
        throw new TypeError('close is not a function');
      },
    };
    assert.throws(() => Task(brokenApi.close()).ignore('api break'), /close is not a function/);
  });

  test('a recipe settles from its return value — sync, async, and void', async (assert) => {
    assert.strictEqual(await Task(() => 42), 42, 'sync value');
    assert.strictEqual(await new Task(() => 42), 42, 'sync value, new form');
    assert.strictEqual(await Task(async () => await Promise.resolve(42)), 42, 'async function');
    assert.strictEqual(
      await new Task(async () => await Promise.resolve(42)),
      42,
      'async function, new form',
    );
    // A recipe returning nothing is a Task<void> that RESOLVES — it must never be mistaken
    // for an executor still waiting on a resolver it was never handed.
    assert.strictEqual(await Task(() => {}), undefined, 'void recipe resolves, never hangs');
  });

  test('an executor settles imperatively — resolve, reject, and the signal third', async (assert) => {
    assert.strictEqual(await Task<number>((resolve) => resolve(42)), 42);
    assert.strictEqual(await new Task<number>((resolve) => resolve(42)), 42, 'new form');

    const failed = await Task<number>((_resolve, reject) => reject(NotFound({ id: 7 }))).result();
    assert.true(Failure.is(failed) && failed.code === 'NotFound', 'reject settles the failure');

    const signals = await Task<boolean>((resolve, _reject, signal) => {
      resolve(signal instanceof AbortSignal);
    });
    assert.true(signals, 'the third parameter is the Task AbortSignal');
  });

  test('an executor may simply RETURN a promise instead of calling resolve', async (assert) => {
    // This is the migration path for cancellation-aware work: name the parameters you need,
    // hand the signal on, and let the returned promise settle the Task.
    assert.strictEqual(await Task<number>((_resolve, _reject, _signal) => Promise.resolve(7)), 7);
    // resolve() and a returned promise race; the first settlement wins, as promises always do.
    const raced = Task<number>((resolve) => {
      resolve(1);
      return Promise.resolve(2);
    });
    assert.strictEqual(await raced, 1);
  });

  test('an async executor that throws rejects the Task — the bug native Promise has', async (assert) => {
    // `new Promise(async () => { throw x })` never settles: the executor's returned promise is
    // discarded, so the throw escapes as an unhandled rejection and every consumer hangs.
    // Honouring the returned promise is what closes that hole here.
    const failed = await Task<string>(async (_resolve) => {
      await Promise.resolve(); // the throw lands in the async body, not synchronously
      throw NotFound({ id: 1 });
    }).result();
    assert.true(Failure.is(failed) && failed.code === 'NotFound', 'the throw became the failure');

    // And an async executor may still settle through its resolver as usual.
    assert.strictEqual(
      await Task<number>(async (resolve) => {
        await Promise.resolve();
        resolve(5);
      }),
      5,
    );
  });

  test('an executor return that is NOT a promise is ignored, exactly as new Promise ignores it', async (assert) => {
    // The rule earns its keep here: `(resolve) => setTimeout(resolve, ms)` implicitly returns a
    // timer handle. Honouring non-promise returns would settle the Task with that handle
    // immediately — breaking the commonest executor idiom there is.
    const started = Date.now();
    const slept = await Task<string>((resolve) => setTimeout(() => resolve('slept'), 40));
    assert.strictEqual(slept, 'slept', 'the timer settled it, not the returned handle');
    assert.true(Date.now() - started >= 35, 'and it genuinely waited');

    // The corollary: a plain value must go through the resolver, which accepts either.
    const maybe = (n: number): number | Promise<number> => (n > 0 ? n : Promise.resolve(0));
    assert.strictEqual(await Task<number>((resolve) => resolve(maybe(5))), 5, 'plain value');
    assert.strictEqual(await Task<number>((resolve) => resolve(maybe(-1))), 0, 'promise');
  });

  test('a promise source works in both spellings, deferring only observation', async (assert) => {
    assert.strictEqual(await Task(Promise.resolve(5)), 5);
    assert.strictEqual(await new Task(Promise.resolve(9)), 9);
  });

  test('both function shapes stay lazy — nothing runs until awaited', (assert) => {
    let recipeRan = 0;
    let executorRan = 0;
    Task(() => {
      recipeRan++;
      return 1;
    });
    Task<number>((resolve) => {
      executorRan++;
      resolve(1);
    });
    assert.strictEqual(recipeRan, 0, 'the recipe did not run');
    assert.strictEqual(executorRan, 0, 'the executor did not run either — unlike new Promise');
  });

  test('perform() starts an executor synchronously, so an event bridge cannot miss its event', async (assert) => {
    let subscribed = false;
    const task = Task<string>((resolve) => {
      subscribed = true;
      queueMicrotask(() => resolve('frame'));
    });
    assert.false(subscribed, 'still lazy before perform');
    task.perform();
    assert.true(subscribed, 'subscribed synchronously — the event cannot land first');
    assert.strictEqual(await task, 'frame');
  });

  test('every retry of an executor gets FRESH resolvers, so a stale one cannot cross-settle', async (assert) => {
    let attempt = 0;
    const resolvers: ((value: number) => void)[] = [];
    const flaky = Task<number>((resolve, reject) => {
      resolvers.push(resolve);
      attempt += 1;
      if (attempt < 3) reject(new Error(`attempt ${attempt}`));
      else resolve(attempt);
    });

    assert.strictEqual(await flaky.retry(3), 3, 'succeeded on the third fresh execution');
    assert.strictEqual(new Set(resolvers).size, resolvers.length, 'no resolver was ever reused');
    // The classic executor hazard: a callback captured during attempt 1 fires late. It settles
    // the attempt it belonged to — which nothing awaits — so the outcome here cannot change.
    resolvers[0](999);
    assert.strictEqual(await flaky.restart(), 4, 'the stale resolve() was inert');
  });

  test('a stale resolver from an earlier attempt cannot settle a later one', async (assert) => {
    // The dangling-resolver worry: attempt 1 subscribes something that closes over ITS
    // resolve, fires late, and settles the wrong attempt. It cannot — every restart binds
    // fresh resolvers to its own promise, and attempt 1's promise already rejected, so
    // invoking its resolver is a no-op on a settled promise.
    const listeners: Array<(value: number) => void> = [];
    let attempt = 0;
    const task = Task<string>((resolve, reject) => {
      const mine = ++attempt;
      listeners.push((value) => resolve(`attempt${mine}-saw-${value}`));
      if (mine === 1) reject(new Error('attempt 1 failed'));
    });

    const settled = task.retry(1).perform();
    await until(() => listeners.length === 2, 'both attempts have subscribed');
    listeners.forEach((fire) => fire(7)); // the STALE one first

    assert.strictEqual(await settled, 'attempt2-saw-7', 'the live attempt settled it');
  });

  test('an attempt retry abandons has its signal fired, so it can clean up', async (assert) => {
    // Abandoned work gets no second chance to tidy up on its own, and the executor is the
    // only shape that can be told — it is the one that receives the signal.
    const cleaned: string[] = [];
    let attempt = 0;
    const root = Task<number>((resolve, reject, signal) => {
      const mine = ++attempt;
      signal.addEventListener('abort', () => cleaned.push(`attempt${mine}`));
      if (mine < 3) reject(new Error(`fail ${mine}`));
      else resolve(mine);
    });

    // Retried through a derived chain: the work lives at the root, so abandoning has to
    // walk the lineage to reach it.
    assert.strictEqual(await root.map((value) => value * 10).retry(3), 30);
    assert.deepEqual(cleaned, ['attempt1', 'attempt2'], 'each abandoned attempt was told');
  });

  test('arity is what selects the shape — rest and defaulted parameters read as recipes', async (assert) => {
    // `fn.length` ignores rest and defaulted parameters, so both declare zero and are recipes.
    // Spelling the parameters out is what asks for an executor.
    assert.strictEqual(await Task((..._args: unknown[]) => 3), 3, 'rest params: a recipe');
    assert.strictEqual(await Task(() => 4), 4);
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
    // Watched rather than assumed: `assert.true(true)` here passed whether or not `ignore`
    // absorbed anything. Filtered to OUR failure so a neighbouring concurrent test's noise
    // cannot fail this one.
    const unhandled: unknown[] = [];
    const watch = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', watch);
    try {
      Task<number>(() => Promise.reject(NotFound({ id: 9 }))).ignore('cleanup');
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', watch);
    }

    assert.false(
      unhandled.some((reason) => NotFound.is(reason)),
      'the ignored rejection never reached the unhandled-rejection handler',
    );
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

  test('retry waits between attempts — a constant, or a function of the attempt', async (assert) => {
    let runs = 0;
    const flaky = () =>
      Task(() => {
        runs += 1;
        if (runs % 3 !== 0) throw NotFound({ id: runs });
        return runs;
      });

    runs = 0;
    const started = Date.now();
    await flaky().retry(2, 20);
    // Lower bound only: two gaps of 20ms must have elapsed. No upper bound — a loaded runner
    // may take much longer, and asserting that it did not is how timing tests go flaky.
    assert.true(Date.now() - started >= 40, 'two waits of 20ms happened between three attempts');

    runs = 0;
    const seen: number[] = [];
    await flaky().retry(2, (attempt) => {
      seen.push(attempt);
      return 1;
    });
    assert.deepEqual(seen, [1, 2], 'the backoff fn is called once per gap, with a 1-based attempt');

    // And no wait at all remains the default, as it always was.
    runs = 0;
    assert.strictEqual(await flaky().retry(2), 3, 'retry(times) alone still retries immediately');
  });

  test('retry bounds each attempt with timeoutMs, abandoning the one that overran', async (assert) => {
    let started = 0;
    let abandoned = 0;
    const neverSettles = Task<number>((_resolve, _reject, signal) => {
      started += 1;
      signal.addEventListener('abort', () => (abandoned += 1));
    });

    const outcome = await neverSettles.retry(1, { timeoutMs: 20 }).result();

    assert.strictEqual(started, 2, 'both attempts ran');
    assert.strictEqual(abandoned, 2, 'and each was told when its deadline passed');
    assert.true(AwaitTimeout.is(outcome), 'the deadline is the failure');
  });

  // Retrying everything is the wrong default for a KNOWN flake: the real failure underneath it
  // gets a pointless second run, and the "we tolerate exactly this one bug" documentation
  // disappears from the code. tokio-retry's `retry_if` condition, as an option.
  test('when() decides which failures are worth another attempt', async (assert) => {
    let attempts = 0;
    const failWith = (message: string) =>
      Task(() => {
        attempts++;
        throw new Error(message);
      });
    const isKnownFlake = (error: unknown) => /handle is invalid/i.test((error as Error).message);

    attempts = 0;
    await failWith('handle is invalid')
      .retry(2, { when: isKnownFlake })
      .recover(() => null);
    assert.strictEqual(attempts, 3, 'the known flake spends every attempt');

    attempts = 0;
    await failWith('ENOENT: no such binary')
      .retry(2, { when: isKnownFlake })
      .recover(() => null);
    assert.strictEqual(attempts, 1, 'anything else surfaces on the first attempt');
  });

  test('a rejected when() skips the delay as well as the attempt', async (assert) => {
    const startedAt = Date.now();
    await Task(() => {
      throw new Error('permanent');
    })
      .retry(3, { delayMs: 500, when: () => false })
      .recover(() => null);

    assert.true(Date.now() - startedAt < 250, 'no attempt means no wait between attempts either');
  });

  test('when() receives the attempt number, so it can stop part-way', async (assert) => {
    const seen: number[] = [];
    let attempts = 0;
    await Task(() => {
      attempts++;
      throw new Error('flaky');
    })
      .retry(5, { when: (_error, attempt) => (seen.push(attempt), attempt < 2) })
      .recover(() => null);

    assert.deepEqual(seen, [1, 2], 'asked after each failure until it said stop');
    assert.strictEqual(attempts, 2);
  });

  test('a pending wait is abortable, so shutdown during one settles now, not later', async (assert) => {
    // The leak this guards: an un-abortable sleep would hold its timer — and the Task — for the
    // full delay. Asserted by observable settling rather than a process-wide handle count,
    // which concurrent test modules would make flaky.
    let runs = 0;
    const task = Task(() => {
      runs += 1;
      throw NotFound({ id: runs });
    })
      .retry(5, 60_000) // a wait far longer than any test would tolerate
      .perform();

    await until(() => runs > 0, 'the first attempt has failed and the wait has begun');
    const startedAt = Date.now();
    await task.shutdown(200);

    assert.true(Date.now() - startedAt < 2_000, 'shutdown did not wait out the 60s delay');
    assert.true(Failure.is(await task.result()), 'and the Task settled rather than hanging');
  });

  test('a failing Task fits where its value type is declared — Task stays covariant in T', async (assert) => {
    // A private field carrying `T` in a parameter position would make the class invariant, and
    // `Task.fail(...)` — whose type is `Task<never, F>` — would stop being assignable to the
    // `Task<Value, F>` a guard clause returns. Native Promise is covariant; so is this. The
    // assertions below are the runtime half; the compile-time half is that this file builds.
    type Config = { port: number };
    const load = (exists: boolean): Task<Config, Failure.Of<typeof NotFound>> => {
      if (!exists) return Task.fail(NotFound({ id: 0 })); // the pattern Task.fail exists for
      return Task(() => ({ port: 8080 }));
    };

    assert.deepEqual(await load(true), { port: 8080 }, 'the happy path still carries the value');
    const failed = await load(false).result();
    assert.true(Failure.is(failed) && failed.code === 'NotFound', 'the guard clause failed');

    // A recipe that only ever throws is `Task<never, …>` too, and fits the same contract.
    const throwsOnly = (): Task<Config, Failure.Of<typeof NotFound>> =>
      Task(() => {
        throw NotFound({ id: 1 });
      });
    assert.true(Failure.is(await throwsOnly().result()), 'and so does an always-throwing recipe');
  });

  test('Task.result takes a foreign promise as well as a Task', async (assert) => {
    // The twin is most useful over a value someone handed you, and that is usually a promise.
    // Before it was widened, `Task.result(promise)` was a type error — and a TypeError at
    // runtime if it reached there from untyped JS, since it delegated straight to .result().
    assert.strictEqual(await Task.result(Task(() => 21 * 2)), 42, 'a Task, as before');
    assert.strictEqual(await Task.result(Promise.resolve(7)), 7, 'and a plain promise');

    // A rejecting promise lands on the failure channel, exactly as a Task's would.
    const failed = await Task.result(Promise.reject(NotFound({ id: 1 })) as Promise<number>);
    assert.true(Failure.is(failed) && failed.code === 'NotFound', 'the rejection is the Err half');

    // A bug still flies past — widening the input did not widen what result() absorbs.
    await assert.rejects(
      Task.result(Promise.reject(new TypeError('bug')) as Promise<number>),
      TypeError,
    );
  });

  test('Task.resolve passes an existing Task through, so its lineage survives', async (assert) => {
    // `Promise.resolve(p)` returns p itself for a same-constructor promise. Wrapping instead
    // would hand back a Task whose restart re-awaits the settled inner one rather than
    // re-running its work — the combinator hole, one layer down.
    let runs = 0;
    const inner = Task(() => ++runs);
    assert.strictEqual(Task.resolve(inner), inner, 'the same instance, not a wrapper');

    assert.strictEqual(await Task.resolve(inner), 1);
    assert.strictEqual(await Task.resolve(inner).restart(), 2, 'restart still reaches the work');

    // A plain value — and a plain FUNCTION — are still lifted as values, never run.
    assert.strictEqual(await Task.resolve(42), 42);
    const fn = () => 'not called';
    assert.strictEqual(typeof (await Task.resolve(fn)), 'function', 'a function stays a value');
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

  // The combined Task must keep the members' DECLARED failure rather than widening it, or every
  // chain that passes through a combinator loses the type it was carrying and `.result()` hands
  // back a union the caller can no longer discriminate. The compile-time half of this is the
  // `Failure.Of<typeof NotFound>` annotation below; the runtime half is that the same value
  // arrives bare.
  test('Task.all keeps the declared failure of its members', async (assert) => {
    const both: Task<{ id: number; name: string }[], Failure.Of<typeof NotFound>> = Task.all([
      loadUser(1),
      loadUser(0),
    ]);

    const outcome = await both.result();

    assert.true(NotFound.is(outcome), 'the failure survives the combinator as its own type');
    assert.strictEqual(NotFound.is(outcome) ? outcome.data.id : -1, 0, 'and keeps its payload');
  });

  test('Task.race keeps it too, and a plain promise member declares nothing', async (assert) => {
    const raced: Task<number, Failure.Of<typeof NotFound>> = Task.race([
      Task<number, Failure.Of<typeof NotFound>>(() => {
        throw NotFound({ id: 7 });
      }),
    ]);
    assert.true(NotFound.is(await raced.result()));

    // A promise contributes `never` to the union, so mixing one in does not widen the rest.
    const mixed: Task<number, Failure.Of<typeof NotFound>> = Task.all([
      Task<number, Failure.Of<typeof NotFound>>(() => 1),
      Promise.resolve(2),
    ]).map((values) => values[0]);
    assert.strictEqual(await mixed, 1);
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
      results.map((r) => (Failure.is(r) ? 'FAIL:' + r.code : r.name)),
      ['u1', 'FAIL:NotFound', 'u3'],
    );
  });

  test('a bug in one task rejects the whole Task.results batch (two-tier)', async (assert) => {
    const buggy = Task<{ id: number; name: string }>(() => {
      throw new TypeError('boom');
    });
    await assert.rejects(Task.results([loadUser(1), buggy]), TypeError);
  });

  test('combinators snapshot a one-shot iterable, so restart() still sees every member', async (assert) => {
    function* gen() {
      yield Task(() => 1);
      yield Task(() => 2);
    }
    const all = Task.all(gen());
    assert.deepEqual(await all, [1, 2]);
    // Without the snapshot, restart() re-iterates the exhausted generator and resolves [].
    assert.deepEqual(await all.restart(), [1, 2]);
    assert.deepEqual(await Task.results(gen()).restart(), [1, 2]);
  });

  test('restart re-runs the members themselves, so retry over a combinator retries the work', async (assert) => {
    // A combinator has no single source to walk, so without this it rebuilt nothing: restart
    // re-awaited members that had already settled and `Task.all(...).retry()` did no work at
    // all — the lineage promise ("a fresh execution of the whole chain") stopped at the
    // combinator's edge.
    let runs = 0;
    const member = () => Task(() => ++runs);

    const all = Task.all([member(), member()]);
    assert.deepEqual(await all, [1, 2]);
    assert.deepEqual(await all.restart(), [3, 4], 'both members ran again');

    // Through a derivation, which is how call sites actually use it.
    runs = 0;
    const chained = Task.all([member(), member()]).map((values) => values.join('+'));
    assert.strictEqual(await chained, '1+2');
    assert.strictEqual(await chained.restart(), '3+4', 'the chain reached the members');

    // And for every combinator, not just `all`.
    runs = 0;
    const raced = Task.race([member()]);
    await raced;
    assert.strictEqual(await raced.restart(), 2, 'race');
    runs = 0;
    const settled = Task.allSettled([member()]);
    await settled;
    assert.deepEqual(await settled.restart(), [{ status: 'fulfilled', value: 2 }], 'allSettled');
    runs = 0;
    const outcomes = Task.results([member()]);
    await outcomes;
    assert.deepEqual(await outcomes.restart(), [2], 'results');
  });

  test('a plain promise member is passed through — it has no second execution to give', async (assert) => {
    // Honest limit: a promise is already running, so a combinator over promises restarts the
    // combination, never the work behind it. Only Task members carry a recipe to re-run.
    let started = 0;
    const promise = (): Promise<number> => Promise.resolve(++started);
    const all = Task.all([promise(), promise()]);
    assert.deepEqual(await all, [1, 2]);
    assert.deepEqual(await all.restart(), [1, 2], 'the same settled promises, re-awaited');
    assert.strictEqual(started, 2, 'nothing ran a second time');
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

  test('mapErr takes a failure factory directly, chaining the cause for you', async (assert) => {
    // Before the overload this exact line compiled and misbehaved: a factory's first parameter
    // is its payload, so the raw error landed in `data` and the cause chain was lost.
    const Unreadable = Failure.define(
      'Unreadable',
      (d: { path: string }) => `cannot read ${d.path}`,
    );
    const Denied = Failure.define('Denied', 'permission denied');
    const foreign = () => Task<string>(() => Promise.reject(new Error('EACCES')));

    const withPayload = await foreign().mapErr(Unreadable, { path: '/etc/app.json' }).result();
    assert.true(Failure.is(withPayload) && withPayload.code === 'Unreadable', 'the declared code');
    assert.deepEqual(
      (withPayload as Failure.Of<typeof Unreadable>).data,
      { path: '/etc/app.json' },
      'the payload is the payload — not the error that was caught',
    );
    assert.strictEqual(
      ((withPayload as Failure.Any).cause as Error).message,
      'EACCES',
      'and the original is chained under cause',
    );

    // A factory with nothing to carry needs no second argument.
    const bare = await foreign().mapErr(Denied).result();
    assert.true(Failure.is(bare) && bare.code === 'Denied', 'the bare factory form');
    assert.strictEqual(((bare as Failure.Any).cause as Error).message, 'EACCES', 'still chained');

    // The function form is untouched, and is still the only one that can read the cause.
    const derived = await foreign()
      .mapErr((cause) => Unreadable({ path: (cause as Error).message }, { cause }))
      .result();
    assert.deepEqual((derived as Failure.Of<typeof Unreadable>).data, { path: 'EACCES' });

    // And the factory form survives a restart, like every other derivation.
    const restarted = await foreign().mapErr(Denied).restart().result();
    assert.true(Failure.is(restarted) && restarted.code === 'Denied', 'lineage keeps the shape');
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

  test('context adds a message to a declared failure, preserving code and data', async (assert) => {
    try {
      await loadUser(0).context('the run needs a user here');
      assert.true(false, 'unreachable');
    } catch (error) {
      assert.true(NotFound.is(error), 'same code — every switch on it still works');
      const failure = error as Failure.Of<typeof NotFound>;
      assert.strictEqual(failure.message, 'the run needs a user here');
      assert.deepEqual(failure.data, { id: 0 }, 'data rides along');
      assert.true(NotFound.is(failure.cause), 'the original failure chains under cause');
    }
  });

  test('context lets a bug pass through uncontextualised', async (assert) => {
    await assert.rejects(buggy().context('context that must NOT wrap a bug'), TypeError);
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

  test('result settles to the bare value or the bare Failure, and RE-THROWS a bug', async (assert) => {
    const success = await loadUser(1).result();
    assert.false(Failure.is(success), 'a success is the value itself — nothing boxed');
    assert.deepEqual(success, { id: 1, name: 'u1' });

    const failed = await loadUser(0).result();
    assert.true(Failure.is(failed), 'a declared failure arrives bare, as a value');
    assert.strictEqual(Failure.is(failed) ? failed.code : undefined, 'NotFound');

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
    const chain = user.map((u) => u.name).context('user must load');
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
    assert.true(Failure.is(await reflected), 'first run failed — the bare failure came back');
    const second = await reflected.restart();
    assert.strictEqual(second, 'ok@2', 'restart re-ran the source, not the reflection');
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
  test('map / mapErr / recover / context delegate exactly', async (assert) => {
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
      await Task.context(loadUser(0), 'twin context');
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
    const failed = await Task.result(loadUser(0));
    assert.true(Failure.is(failed), 'the failure arrives bare');
    assert.strictEqual(Failure.is(failed) ? failed.code : undefined, 'NotFound');
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
    let ran = false;
    Task(() => {
      ran = true;
      throw NotFound({ id: 1 });
    }); // never awaited, never performed
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The claim is that the work never ran — which is WHY nothing could reject. Asserting that
    // directly fails if laziness ever regresses; the previous `assert.true(true)` could not.
    assert.false(ran, 'the work never ran, so there was no rejection to go unhandled');
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

// ── ensure — the declared invariant on the success value ───────────────────────

module('Task | finally', { concurrency: true }, () => {
  test('returns a Task, so cleanup no longer drops the chain out of Task-land', async (assert) => {
    const task = Task(() => 'body').finally(() => {});

    assert.true(task instanceof Task, 'then/catch hand back a plain Promise; finally does not');
    assert.strictEqual(await task.map((body) => body.toUpperCase()), 'BODY', 'still chainable');
  });

  test('keeps every Promise.prototype.finally behaviour', async (assert) => {
    assert.strictEqual(await Task(() => 1).finally(() => 99), 1, "onFinally's return is discarded");

    await assert.rejects(
      Task(() => 1).finally(() => {
        throw new Error('cleanup blew up');
      }),
      /cleanup blew up/,
      'but a throwing onFinally does replace the outcome',
    );

    await assert.rejects(
      Task(() => Promise.reject(NotFound({ id: 3 }))).finally(() => {}),
      /no user 3/,
    );

    const startedAt = Date.now();
    await Task(() => 1).finally(() => new Promise((resolve) => setTimeout(resolve, 30)));
    assert.true(Date.now() - startedAt >= 25, 'a thenable returned by onFinally is awaited');

    let args: unknown[] = ['not called'];
    await Task(() => 1).finally((...received: unknown[]) => (args = received));
    assert.deepEqual(args, [], 'onFinally receives nothing — it cannot see the outcome');
  });

  // Deliberately EAGER, like ignore(): `finally` is overwhelmingly written fire-and-forget, and
  // a lazy one nobody awaited would silently never release the resource.
  test('runs the cleanup with no await at all — the fire-and-forget idiom', async (assert) => {
    let released = false;
    Task(() => 'x').finally(() => (released = true));

    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.true(released, 'a lazy finally would have released nothing here');
  });

  // The reason the docs point at try/finally instead of this method: a plain try/finally inside
  // the recipe gives the SAME per-attempt cleanup, stays lazy, and builds no extra running Task
  // to leave unowned. `finally` earns its place only as Promise compatibility.
  test('try/finally in the recipe matches it, without the eager derived Task', async (assert) => {
    let attempts = 0;
    let cleanups = 0;
    const task = Task(() => {
      try {
        if (++attempts < 3) throw new Error('again');
        return attempts;
      } finally {
        cleanups++;
      }
    });

    assert.strictEqual(await task.retry(5), 3);
    assert.strictEqual(cleanups, 3, 'one cleanup per attempt — same as .finally() would give');

    let ran = false;
    Task(() => {
      try {
        ran = true;
      } finally {
        /* nothing to release */
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.false(ran, 'and unlike .finally(), it does not start anything on its own');
  });

  test('cleanup re-runs per attempt when the retry is upstream of it', async (assert) => {
    let attempts = 0;
    let cleanups = 0;
    const flaky = Task(() => {
      if (++attempts < 2) throw new Error('again');
      return attempts;
    });

    assert.strictEqual(await flaky.retry(2).finally(() => cleanups++), 2);
    assert.strictEqual(cleanups, 1, 'one cleanup for the whole retried chain');
  });
});

// Rust's `Result::or_else`, and the piece the API was missing: a fallback that is itself
// allowed to fail. `recover` cannot express it — its `E` is `never`, so it has nowhere to put a
// failure the handler wants to report.
module('Task | orElse', { concurrency: true }, () => {
  test('a declared failure gets the fallback, and the channel stays open', async (assert) => {
    const primary = Task<{ id: number; name: string }, Failure.Of<typeof NotFound>>(() => {
      throw NotFound({ id: 7 });
    });

    const replaced: Task<
      { id: number; name: string },
      Failure.Of<typeof NotFound>
    > = primary.orElse(() => loadUser(7));

    assert.deepEqual(await replaced, { id: 7, name: 'u7' });
  });

  test('the fallback may fail too, and its failure is still discriminable', async (assert) => {
    const outcome = await Task<{ id: number; name: string }>(() => {
      throw NotFound({ id: 7 });
    })
      .orElse(() => loadUser(0)) // 0 misses as well
      .result();

    assert.true(NotFound.is(outcome), 'not swallowed into a value the way recover would');
    assert.strictEqual(
      (outcome as Failure.Of<typeof NotFound>).data.id,
      0,
      "the FALLBACK's failure",
    );
  });

  // The two-tier line, and the reason this is not just `recover` with a different return type:
  // "retry the replica when the primary says NotFound" is a plan; "retry the replica when the
  // primary threw a TypeError" ships the TypeError twice.
  test('a bug gets no fallback — it is not a planned outcome', async (assert) => {
    let fallbackRan = false;
    const buggy = Task<number>(() => {
      throw new TypeError('a real bug');
    });

    await assert.rejects(
      buggy.orElse(() => {
        fallbackRan = true;
        return Task(() => 0);
      }),
      TypeError,
    );
    assert.false(fallbackRan, 'the fallback was never reached');
  });

  test('a success passes through without calling the fallback', async (assert) => {
    let fallbackRan = false;
    const value = await Task(() => 'ok').orElse(() => {
      fallbackRan = true;
      return Task(() => 'replacement');
    });

    assert.strictEqual(value, 'ok');
    assert.false(fallbackRan);
  });

  test('Task.orElse is the data-first twin', async (assert) => {
    const failing = Task<string>(() => {
      throw NotFound({ id: 1 });
    });

    assert.strictEqual(await Task.orElse(failing, () => Task(() => 'twin')), 'twin');
  });

  // Both halves must fail for `retry` to have anything to do — a satisfied `orElse` succeeds,
  // so the chain succeeds and the retry never fires. With both failing, retry has to restart the
  // SOURCE through the orElse rather than re-read its settled answer.
  test('lineage survives it — retry restarts the source through the fallback', async (assert) => {
    let attempts = 0;
    const flaky = Task<string>(() => {
      if (++attempts < 3) throw NotFound({ id: attempts });
      return `ok after ${attempts}`;
    });
    const alsoMisses = () =>
      Task<string>(() => {
        throw NotFound({ id: 99 });
      });

    assert.strictEqual(await flaky.orElse(alsoMisses).retry(3), 'ok after 3');
    assert.strictEqual(attempts, 3, 'the source ran again each time, not the cached rejection');
  });

  test('a satisfied fallback ends the chain, so an outer retry never fires', async (assert) => {
    let attempts = 0;
    const failing = Task<string>(() => {
      attempts++;
      throw NotFound({ id: 1 });
    });

    assert.strictEqual(await failing.orElse(() => Task(() => 'handled')).retry(3), 'handled');
    assert.strictEqual(attempts, 1, 'nothing to retry once orElse has answered');
  });
});

module('Task | ensure', { concurrency: true }, () => {
  const TooSmall = Failure.define('TooSmall', (d: { got: number }) => `too small: ${d.got}`);

  test('passes the value through when the predicate holds', async (assert) => {
    assert.strictEqual(
      await Task(() => 5).ensure(
        (n) => n > 3,
        (n) => TooSmall({ got: n }),
      ),
      5,
    );
  });

  test('rejects with the declared failure built FROM the value otherwise', async (assert) => {
    const failed = await Task(() => 2)
      .ensure(
        (n) => n > 3,
        (n) => TooSmall({ got: n }),
      )
      .result();
    assert.true(TooSmall.is(failed));
    assert.strictEqual((failed as Failure.Of<typeof TooSmall>).data.got, 2);
  });

  test('stays lazy, carries lineage, and the static twin agrees', async (assert) => {
    let ran = 0;
    const guarded = Task(() => ++ran).ensure(
      (n) => n === 1,
      (n) => TooSmall({ got: n }),
    );
    assert.strictEqual(ran, 0, 'ensure built lazily');
    assert.strictEqual(await guarded, 1);
    const failedSecond = await guarded.restart().result(); // re-runs the WHOLE chain: ran → 2
    assert.true(TooSmall.is(failedSecond), 'lineage re-ran the recipe, invariant re-checked');
    assert.strictEqual(
      await Task.ensure(
        Task(() => 9),
        (n) => n > 3,
        (n) => TooSmall({ got: n }),
      ),
      9,
    );
  });
});

// ── The Elixir Task family: async/await pair, yield, shutdown, completed ──────

// Serial: deno's step sanitizer misattributes cross-step timer waits under concurrency
// (the deadline tests hold real timers; a sibling draining first trips "loop resolved").
module('Task | elixir family', () => {
  test('async starts NOW; await joins with a deadline', async (assert) => {
    let ran = false;
    const task = Task.async(() => {
      ran = true;
      return 21 * 2;
    });
    assert.true(ran, 'async performed immediately — the async half of the pair');
    assert.strictEqual(await task.await(1000), 42);
  });

  test('await rejects with a declared AwaitTimeout — and does NOT consume the run', async (assert) => {
    let settle!: (n: number) => void;
    const slow = Task<number>(() => new Promise<number>((res) => (settle = res)));
    const timedOut = await slow.await(10).catch((e: unknown) => e);
    assert.true(Failure.is(timedOut));
    assert.true(AwaitTimeout.is(timedOut), 'the guard narrows it — no string compare');
    settle(7);
    assert.strictEqual(await slow, 7, 'the run survived the deadline — a later await joins it');
  });

  test('yield polls without consuming; yieldMany reports each slot', async (assert) => {
    const fast = Task(() => 1);
    const never = Task<number>(() => new Promise<never>(() => {}));
    assert.strictEqual(await fast.yield(50), 1, 'settled within the window, bare');
    assert.strictEqual(await fast.yield(50), 1, 're-yield sees the memo — non-destructive');
    assert.deepEqual(await Task.yieldMany([fast, never], 20), [1, null]);
  });

  test('awaitMany shares ONE deadline across all tasks', async (assert) => {
    assert.deepEqual(await Task.awaitMany([Task(() => 1), Task(() => 2)], 1000), [1, 2]);
    const stuck = [Task(() => 1), Task<number>(() => new Promise<never>(() => {}))];
    const timedOut = await Task.awaitMany(stuck, 10).catch((e: unknown) => e);
    assert.true(AwaitTimeout.is(timedOut), 'the guard narrows it — no string compare');
  });

  test('completed is settled before any window', async (assert) => {
    assert.strictEqual(await Task.completed(42), 42);
    assert.strictEqual(await Task.completed(42).yield(0), 42);
  });

  test('shutdown fires the recipe signal; cancellation-aware work stops', async (assert) => {
    let aborted = false;
    // The executor form IS the cancellation-aware shape: no `new Promise` wrapper, because the
    // Task hands over its own resolvers.
    const task = Task<number>((_resolve, reject, signal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      });
    }).perform();
    const outcome = await task.shutdown(50);
    assert.true(aborted, 'the AbortSignal reached the executor');
    assert.strictEqual(outcome, null, 'nothing useful had landed');
    const after = await task.result();
    assert.true(Failure.is(after), 'every later consumer resolves — no hung awaits');
    assert.true(Shutdown.is(after), 'and it says why');
  });

  // The work lives on the SOURCE — `map`/`mapErr`/`context` only wrap `this.then(...)`. Aborting
  // one link therefore has to walk the chain, or cancelling anything built the way the docs show
  // fires a signal nobody is listening to and leaves the real work running.
  test('shutdown reaches through a derived chain to the work that is actually running', async (assert) => {
    let aborted = false;
    const root = Task<number>((resolve, _reject, signal) => {
      signal.addEventListener('abort', () => (aborted = true));
      setTimeout(() => resolve(1), 60_000);
    });
    const chain = root.map((n) => n + 1).context('reading the thing');
    chain.perform();

    assert.strictEqual(await chain.shutdown(20), null);
    assert.true(aborted, "the ROOT's signal fired, not just the derived link's");
  });

  test('shutdown reaches a combinator’s members too', async (assert) => {
    let aborted = false;
    const member = Task<number>((resolve, _reject, signal) => {
      signal.addEventListener('abort', () => (aborted = true));
      setTimeout(() => resolve(1), 60_000);
    });
    const combined = Task.all([member]);
    combined.perform();
    await new Promise((resolve) => setTimeout(resolve, 5)); // let Promise.all subscribe

    await combined.shutdown(20);

    assert.true(aborted, 'a combinator has many sources, and cancellation reaches each');
  });

  test('shutdown of a never-started task settles it without running the recipe', async (assert) => {
    let ran = false;
    const task = Task(() => {
      ran = true;
      return 1;
    });
    assert.strictEqual(await task.shutdown(10), null);
    assert.false(ran, 'the recipe never ran');
    assert.true(Failure.is(await task.result()), 'consumers see Shutdown, not a hang');
  });

  test('shutdown returns the Result when the work already landed', async (assert) => {
    const done = Task(() => 9).perform();
    await done;
    assert.strictEqual(await done.shutdown(50), 9, 'the settled value, bare — nothing lost');
  });
});
