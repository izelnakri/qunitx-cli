import { Worker } from 'node:worker_threads';
import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { Failure } from '../../lib/task/index.ts';

const NotFound = Failure.define('NotFound', (d: { id: number }) => `no user ${d.id}`);
const OriginObserved = Failure.define('OriginObserved', 'origin-observe test');

module('Node | memory cluster', () => {
  test('start/hello/list/self/alive — the cluster sees itself', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@memory', hub.transport());
    const b = Node.start('b@memory', hub.transport());
    await new Promise((r) => setTimeout(r, 10)); // hellos ride microtasks
    assert.strictEqual(a.self(), 'a@memory');
    assert.true(a.alive());
    assert.deepEqual(a.list(), ['b@memory']);
    assert.deepEqual(b.list(), ['a@memory']);
    a.stop();
    b.stop();
    assert.false(a.alive());
  });

  test('call round-trips values; a remote DECLARED failure arrives declared, bare', async (assert) => {
    const hub = Node.memoryHub();
    const client = Node.start('client@memory', hub.transport());
    const server = Node.start('server@memory', hub.transport());
    server.handle('math.add', (payload) => (payload as number[]).reduce((x, y) => x + y, 0));
    server.handle('user.get', (payload) => NotFound({ id: payload as number })); // failure AS the reply

    assert.strictEqual(await client.call('server@memory', 'math.add', [20, 22]), 42);
    const outcome = await client.call('server@memory', 'user.get', 9).result();
    assert.true(NotFound.is(outcome), 'crossed the wire via $failure envelope, revived by code');
    assert.strictEqual((outcome as Failure.Of<typeof NotFound>).data.id, 9, 'typed data intact');
    client.stop();
    server.stop();
  });

  test('NoHandler, RemoteCrash and CallTimeout are declared transport failures', async (assert) => {
    const hub = Node.memoryHub();
    const client = Node.start('c@memory', hub.transport());
    const server = Node.start('s@memory', hub.transport());
    server.handle('boom', () => {
      throw new TypeError('handler bug');
    });

    const missing = await client.call('s@memory', 'nope').result();
    assert.strictEqual((missing as Failure.Any).code, 'NoHandler');
    const crashed = await client.call('s@memory', 'boom').result();
    assert.strictEqual(
      (crashed as Failure.Any).code,
      'RemoteCrash',
      'a remote bug is DECLARED to the caller — the wire is a crash boundary',
    );
    const gone = await client.call('ghost@memory', 'anything', null, 30).result();
    assert.strictEqual((gone as Failure.Any).code, 'CallTimeout');
    client.stop();
    server.stop();
  });

  test('a call Task is retryable — .retry() RE-SENDS the request, not just re-waits', async (assert) => {
    const hub = Node.memoryHub();
    const client = Node.start('c@memory', hub.transport());
    const server = Node.start('s@memory', hub.transport());
    let attempts = 0;
    server.handle('flaky', (payload) => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient'); // fail the first two, succeed on the third
      return (payload as { n: number }).n * 2;
    });

    const answer = await client.call<number>('s@memory', 'flaky', { n: 21 }).retry(5);
    assert.strictEqual(answer, 42, 'retry re-dispatched until the handler succeeded');
    assert.strictEqual(
      attempts,
      3,
      'the server saw a fresh send per attempt (not one send re-awaited)',
    );

    // A retry budget that runs out still surfaces the last failure, not a hang.
    server.handle('always', () => {
      throw new Error('never works');
    });
    const givenUp = await client.call('s@memory', 'always').retry(2).result();
    assert.strictEqual(
      (givenUp as Failure.Any).code,
      'RemoteCrash',
      'exhausted retry (3 attempts) surfaces the last reason instead of hanging',
    );
    client.stop();
    server.stop();
  });

  test('cast is fire-and-forget; ping answers pong or pang; monitor fires on bye', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@memory', hub.transport());
    const b = Node.start('b@memory', hub.transport());
    const seen: unknown[] = [];
    const downs: string[] = [];
    b.handle('log', (payload) => void seen.push(payload));
    a.monitor((peer) => void downs.push(peer));
    a.cast('b@memory', 'log', { level: 'info' });
    assert.strictEqual(await a.ping('b@memory', 200), 'pong');
    assert.strictEqual(await a.ping('ghost@memory', 30), 'pang');
    b.stop();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen, [{ level: 'info' }]);
    assert.deepEqual(downs, ['b@memory'], 'the monitor fired on bye');
    a.stop();
  });

  test('monitorNodes reports both nodeup and nodedown (net_kernel.monitor_nodes)', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@memory', hub.transport());
    const events: string[] = [];
    a.monitorNodes(({ node, status }) => void events.push(`${status}:${node}`));
    const b = Node.start('b@memory', hub.transport()); // joins → nodeup
    await new Promise((r) => setTimeout(r, 10));
    b.stop(); // says bye → nodedown
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(events, ['up:b@memory', 'down:b@memory'], 'up then down, in order');
    a.stop();
  });

  test('a handler that THROWS a declared Failure is routed to Failure.onObserved at its origin', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const cli = Node.start('cli@memory', hub.transport());
    svc.handle('charge', () => {
      throw OriginObserved(); // a bare throw — the handler never `.result()`s it for observability
    });
    const seen: string[] = [];
    Failure.onObserved((failure) => void seen.push(failure.code));
    try {
      // Consume the reply WITHOUT `.result()` — a bare `await` doesn't observe — so `seen` can only
      // reflect the ORIGIN observation the serving node did on the throw, never a caller-side one.
      let reply: unknown;
      try {
        await cli.call('svc@memory', 'charge', null);
      } catch (thrown) {
        reply = thrown;
      }
      assert.strictEqual(
        (reply as Failure.Any).code,
        'OriginObserved',
        'the caller still gets the thrown Failure back',
      );
      assert.strictEqual(
        seen.filter((code) => code === 'OriginObserved').length,
        1,
        'and it hit Failure.onObserved exactly once — at origin, no `.result()` in the handler',
      );
    } finally {
      Failure.onObserved(null); // detach the process-wide observer
      svc.stop();
      cli.stop();
    }
  });
});

module('Node | worker transport', () => {
  test('a real worker_threads hop: values AND failures cross postMessage intact', async (assert) => {
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno — the node lane owns the worker_threads assert');
      return;
    }
    const nodeUrl = new URL('../../lib/node/index.ts', import.meta.url).href;
    const worker = new Worker(
      `
      const { parentPort } = require('node:worker_threads');
      (async () => {
        const Node = await import(${JSON.stringify(nodeUrl)});
        const { Failure } = await import(${JSON.stringify(new URL('../../lib/task/index.ts', import.meta.url).href)});
        const Denied = Failure.define('Denied', (d) => 'denied: ' + d.user);
        const me = Node.start('svc@workers', Node.fromPort(parentPort));
        me.handle('sum', (ns) => ns.reduce((a, b) => a + b, 0));
        me.handle('login', (user) => Denied({ user }));
      })();
    `,
      { eval: true },
    );
    const main = Node.start('main@workers', Node.fromPort(worker));
    await new Promise((r) => setTimeout(r, 300)); // worker boot + hello
    assert.strictEqual(await main.call('svc@workers', 'sum', [1, 2, 3], 3000), 6);
    const denied = await main.call('svc@workers', 'login', 'root', 3000).result();
    assert.strictEqual(
      (denied as Failure.Any).code,
      'Denied',
      'structuredClone did NOT gut it — the $failure envelope carried identity',
    );
    main.stop();
    await worker.terminate();
  });
});
