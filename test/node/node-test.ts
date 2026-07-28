import { Worker } from 'node:worker_threads';
import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { Failure } from '../../lib/task/index.ts';

const NotFound = Failure.define('NotFound', (d: { id: number }) => `no user ${d.id}`);

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
