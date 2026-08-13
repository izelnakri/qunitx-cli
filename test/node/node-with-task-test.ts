import { module, test } from 'qunitx';
import { Node, memoryHub } from '../../lib/node/index.ts';
import { Task, Failure } from '../../lib/task/index.ts';

// A declared failure a handler throws on purpose — its `code`, `message`, and `data` must survive the
// node hop intact ("declared failures arrive declared"); `shape` marks which variation raised it.
const Boom = Failure.define('Boom', (d: { shape: string }) => `boom in ${d.shape}`);

// Assert a call's settled result IS a Failure and hand it back narrowed — no `if (Failure.is(...))`
// dance at every call site. `Asserter` is the sliver of qunitx's `assert` we need (structural, so we
// don't depend on a `qunitx`-exported type).
type Asserter = { true(value: unknown, message?: string): void };
const expectFailure = (assert: Asserter, result: unknown, why: string): Failure.Any => {
  assert.true(Failure.is(result), why);
  return result as Failure.Any;
};

// `client.call('server@c', subject)` returns a `Task<T, AnyFailure>` addressed to ONE named node.
// `node.handle` awaits the handler, so the Task rule holds: RETURN or AWAIT a Task → it runs, and on
// failure the returned Task REJECTS with the Failure. We read that with `.result()` (settles to
// `T | Failure` WITHOUT throwing — a bare `await call(...)` would throw). A CREATED-AND-DROPPED lazy
// Task is a no-op. In-process nodes share one memoryHub, so a handler's side effect lands in a shared
// `ran` array we read directly. Runs on BOTH lanes (no worker threads).
//
// One test per Task-in-a-handler shape (m–p) + the raw-throw path — a failure in one no longer masks
// the rest. Nothing here throws (good calls resolve, failing ones are read via `.result()`), so each
// test just `stop()`s its two nodes at the end.
module('Node | specific node | Task inside a handler', () => {
  // A linked server+client pair on a fresh in-process hub (isolated per test) + a `stop()` for cleanup.
  const prepare = () => {
    const hub = memoryHub();
    const ran: string[] = [];
    const server = Node.start('server@c', hub.transport());
    const client = Node.start('client@c', hub.transport());
    return {
      ran,
      server,
      call: (subject: string) => client.call('server@c', subject),
      stop: () => {
        client.stop();
        server.stop();
      },
    };
  };

  test('(m) return task — runs on the server; its Failure crosses back with code + message + data', async (assert) => {
    const { ran, server, call, stop } = prepare();
    server.handle('ok', () =>
      Task(() => {
        ran.push('m');
        return 'v';
      }),
    );
    server.handle('bad', () =>
      Task(() => {
        throw Boom({ shape: 'm' });
      }),
    );
    assert.equal(await call('ok'), 'v', 'the returned Task ran → its value crossed back');
    assert.true(ran.includes('m'), 'the Task RAN on the server node');

    const failure = expectFailure(assert, await call('bad').result(), 'the failure crossed back');
    assert.equal(
      failure.code,
      'Boom',
      'a DECLARED failure arrives declared — code survives the hop',
    );
    assert.equal(failure.message, 'boom in m', 'the rendered message survives too');
    assert.deepEqual(failure.data, { shape: 'm' }, 'and its data survives the codec round-trip');
    stop();
  });

  test('(n) return await task — identical: runs, Failure crosses back with code + message + data', async (assert) => {
    const { ran, server, call, stop } = prepare();
    server.handle(
      'ok',
      async () =>
        await Task(() => {
          ran.push('n');
          return 'v';
        }),
    );
    server.handle(
      'bad',
      async () =>
        await Task(() => {
          throw Boom({ shape: 'n' });
        }),
    );
    assert.equal(await call('ok'), 'v', 'the awaited Task’s value crossed back');
    assert.true(ran.includes('n'), 'the Task RAN');

    const failure = expectFailure(
      assert,
      await call('bad').result(),
      'the await threw → a Failure',
    );
    assert.equal(failure.code, 'Boom', 'declared → code survives the hop');
    assert.equal(failure.message, 'boom in n', 'and its rendered message');
    assert.deepEqual(failure.data, { shape: 'n' }, 'and its data survives the codec round-trip');
    stop();
  });

  test('(o) create-and-drop — a dropped LAZY task never runs, so the handler just succeeds', async (assert) => {
    const { ran, server, call, stop } = prepare();
    server.handle('ok', () => {
      Task(() => ran.push('o')); // created, never awaited → lazy → dropped
      return 'x';
    });
    server.handle('bad', () => {
      Task(() => {
        throw Boom({ shape: 'o' }); // even a declared failure, dropped lazily, never fires
      });
      return 'x';
    });
    // Neither handler propagates — both just return 'x' — so nothing here throws; no `.result()` needed.
    assert.equal(await call('ok'), 'x', 'the handler returned x');
    assert.false(ran.includes('o'), 'the dropped LAZY task did NOT run — nothing triggered it');
    assert.equal(
      await call('bad'),
      'x',
      'the dropped throwing task never ran → the call SUCCEEDED with x, no Failure',
    );
    stop();
  });

  test('(p) await task; return x — a throwing await short-circuits: the return + everything after never runs', async (assert) => {
    const { ran, server, call, stop } = prepare();
    server.handle('ok', async () => {
      await Task(() => ran.push('p'));
      return 'x';
    });
    server.handle('bad', async () => {
      await Task(() => {
        throw Boom({ shape: 'p' });
      });
      ran.push('p:after'); // MUST NOT run — the awaited Task threw, unwinding the handler
      return 'x';
    });
    assert.equal(await call('ok'), 'x', 'the handler returned x');
    assert.true(ran.includes('p'), 'await triggered the Task');

    const failure = expectFailure(
      assert,
      await call('bad').result(),
      'the await threw → a Failure',
    );
    assert.equal(failure.code, 'Boom', 'declared → code survives the hop');
    assert.equal(failure.message, 'boom in p', 'and its rendered message');
    assert.deepEqual(failure.data, { shape: 'p' }, 'and its data survives the codec round-trip');
    assert.false(
      ran.includes('p:after'),
      'the throwing await STOPPED execution — the code after it (and `return x`) never ran',
    );
    stop();
  });

  test('(raw) a non-Failure throw (a bug) crosses as a RemoteCrash Failure that names the subject', async (assert) => {
    const { server, call, stop } = prepare();
    server.handle('bug', () =>
      Task(() => {
        throw new Error('kaboom'); // a plain Error — a bug, not a declared failure
      }),
    );
    const failure = expectFailure(
      assert,
      await call('bug').result(),
      'a plain Error still crosses as a Failure (never a clone-gutted Error)',
    );
    assert.equal(failure.code, 'RemoteCrash', 'an undeclared throw is coerced to code RemoteCrash');
    assert.true(
      String(failure.message).includes('kaboom'),
      'the original error text is preserved in the message',
    );
    assert.deepEqual(failure.data, { subject: 'bug' }, 'RemoteCrash tags which subject blew up');
    stop();
  });
});
