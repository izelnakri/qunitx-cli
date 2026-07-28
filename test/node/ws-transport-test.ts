import { spawn } from 'node:child_process';
import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { startHub } from '../../lib/node/hub.ts';
import { Failure } from '../../lib/task/index.ts';

// The distribution proof: a REAL second OS process joins the cluster through the hub, and
// values, raw bytes, and declared failures all cross the socket intact. Node-lane only —
// the hub stands on the `ws` package and the peer is a spawned `node` process.
module('Node | ws distribution', () => {
  test('two OS processes, one cluster: call/bytes/failures/nodedown across the wire', async (assert) => {
    if ('Deno' in globalThis) {
      assert.true(true, 'skipped under Deno — the node lane owns the multi-process assert');
      return;
    }
    const hub = startHub({ port: 0 });
    const port = hub.port();
    const nodeUrl = new URL('../../lib/node/index.ts', import.meta.url).href;
    const taskUrl = new URL('../../lib/task/index.ts', import.meta.url).href;
    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      `const Node = await import(${JSON.stringify(nodeUrl)});` +
        `const { Failure } = await import(${JSON.stringify(taskUrl)});` +
        `const Denied = Failure.define('Denied', (d) => 'denied: ' + d.user);` +
        `const svc = Node.start('svc@cluster', Node.wsTransport('ws://127.0.0.1:${port}'));` +
        `svc.handle('sum', (ns) => ns.reduce((a, b) => a + b, 0));` +
        `svc.handle('login', (user) => Denied({ user }));` +
        `svc.handle('hash', (bytes) => new Uint8Array(bytes.map((b) => b ^ 255)));` +
        `setInterval(() => {}, 1000);`, // stay alive until killed
    ]);
    child.stderr.on('data', (chunk) => console.error('child:', String(chunk)));

    const me = Node.start('main@cluster', Node.wsTransport(`ws://127.0.0.1:${port}`));
    const downs: string[] = [];
    me.monitor((peer) => void downs.push(peer));
    for (let i = 0; i < 100 && !me.list().includes('svc@cluster'); i++) {
      await new Promise((r) => setTimeout(r, 100)); // child boot + type-strip + hello
    }
    assert.deepEqual(me.list(), ['svc@cluster'], 'the other PROCESS is a listed peer');

    assert.strictEqual(await me.call('svc@cluster', 'sum', [20, 22], 5000), 42);
    assert.strictEqual(await me.ping('svc@cluster', 5000), 'pong');

    const hashed = await me.call<Uint8Array>(
      'svc@cluster',
      'hash',
      new Uint8Array([0, 255, 128]),
      5000,
    );
    assert.deepEqual(
      [...hashed],
      [255, 0, 127],
      'raw bytes crossed BOTH ways — no base64, binary codec',
    );

    const denied = await me.call('svc@cluster', 'login', 'root', 5000).result();
    assert.true(Failure.is(denied), 'a remote declared failure arrived declared');
    assert.strictEqual((denied as Failure.Any).code, 'Denied');
    assert.deepEqual(
      (denied as Failure.Any).data,
      { user: 'root' },
      'typed data intact across the socket',
    );

    child.kill('SIGKILL'); // no polite bye — the hub must say it for the corpse
    for (let i = 0; i < 100 && downs.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(downs, ['svc@cluster'], "Erlang's nodedown: monitor fired on socket drop");

    me.stop();
    await hub.close();
  });
});

module('Node | codecs', { concurrency: true }, () => {
  const frame: Node.Frame = {
    kind: 'call',
    from: 'a@ws',
    to: 'b@ws',
    subject: 'blob',
    ref: 7,
    payload: { nested: [1, 'two', true, null, new Uint8Array([9, 8])], pi: 3.14159 },
  };

  test('binaryCodec round-trips every value kind, bytes as bytes', (assert) => {
    const wire = Node.binaryCodec.encode(frame) as Uint8Array;
    assert.strictEqual(wire[0], 158, 'our magic byte (ETF owns 131)');
    const back = Node.binaryCodec.decode(wire);
    assert.strictEqual(back.kind, 'call');
    assert.strictEqual(back.ref, 7);
    assert.strictEqual((back.payload as { pi: number }).pi, 3.14159);
    const nested = (back.payload as { nested: unknown[] }).nested;
    assert.true(nested[4] instanceof Uint8Array, 'bytes stayed bytes');
    assert.deepEqual([...(nested[4] as Uint8Array)], [9, 8]);
  });

  test('jsonCodec round-trips with $b64 bytes — the readable reference wire', (assert) => {
    const text = Node.jsonCodec.encode(frame) as string;
    assert.true(text.includes('$b64'), 'binary rode base64');
    const back = Node.jsonCodec.decode(text);
    const nested = (back.payload as { nested: unknown[] }).nested;
    assert.true(nested[4] instanceof Uint8Array);
    assert.deepEqual([...(nested[4] as Uint8Array)], [9, 8]);
    assert.strictEqual((back.payload as { pi: number }).pi, 3.14159);
  });

  test('a $failure envelope survives the binary wire with identity intact', (assert) => {
    const NotFound = Failure.define('NotFound', (d: { id: number }) => `no ${d.id}`);
    const wire = Node.binaryCodec.encode({
      kind: 'reply',
      from: 's@ws',
      to: 'c@ws',
      ref: 1,
      $failure: Failure.toJSON(NotFound({ id: 4 })),
    });
    const revived = Failure.fromJSON(Node.binaryCodec.decode(wire as Uint8Array).$failure!);
    assert.true(NotFound.is(revived));
    assert.deepEqual(revived.data, { id: 4 });
  });
});
