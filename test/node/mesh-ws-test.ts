import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { wsMeshTransport } from '../../lib/node/mesh-ws.ts';

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
// CI sockets (win32/macos runners under load) can take seconds to establish — the ceilings are
// generous; green runs return as soon as the condition holds.
const until = async (cond: () => boolean, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return cond();
};
// A call retried across churn: during a re-dial window a frame buffered on a link whose socket
// then fails is LOST (fire-and-forget wire) — the caller retries, which is the documented
// contract for distributed calls during membership churn.
const tryCall = async <T>(node: Node.NodeHandle, to: string, subject: string): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return (await node.call<T>(to, subject, undefined, 2000)) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

// The REAL mesh: OS-level WebSocket listeners, per-peer dialed sockets, no relay hub. The roster
// starts EMPTY (ports are OS-assigned), then fills — exercising late discovery + the transport's
// re-announce, the exact production boot sequence with cluster() discovery.
module('Node | mesh over real WebSockets', () => {
  test('three nodes converge and route directed calls peer-to-peer over live sockets', async (assert) => {
    const names = ['a@wsm', 'b@wsm', 'c@wsm'];
    const urls: Record<string, string> = {}; // filled AFTER listeners bind (port 0)
    const meshes = names.map((name) =>
      wsMeshTransport(name, { port: 0, peers: () => urls, pollMs: 25 }),
    );
    const nodes = names.map((name, i) => Node.start(name, meshes[i].transport));
    try {
      for (const n of nodes) n.handle('who', () => n.self());
      await settle(); // listeners are up; now publish the roster (late discovery)
      names.forEach((name, i) => (urls[name] = `ws://127.0.0.1:${meshes[i].port()}`));

      assert.true(
        await until(() => nodes.every((n) => n.list().length === 2)),
        'every node discovered both peers over live sockets',
      );
      for (const from of nodes)
        for (const to of names)
          if (to !== from.self())
            assert.equal(
              await tryCall(from, to, 'who'),
              to,
              `${from.self()} → ${to} routed directly`,
            );

      // Registry gossip converges across the socket mesh too.
      nodes[0].register('rooms', 'lobby');
      assert.true(
        await until(() => nodes.every((n) => n.whereis('rooms', 'lobby') === 'a@wsm')),
        'a registration converged across the socket mesh',
      );
    } finally {
      for (const n of nodes) n.stop();
      await Promise.all(meshes.map((m) => m.close())); // a failed assertion must NOT leak listeners
    }
  });

  test('a killed peer socket is re-dialed and the pair recovers', async (assert) => {
    const urls: Record<string, string> = {};
    const meshA = wsMeshTransport('a@wsr', { port: 0, peers: () => urls, pollMs: 25 });
    const meshB = wsMeshTransport('b@wsr', { port: 0, peers: () => urls, pollMs: 25 });
    const a = Node.start('a@wsr', meshA.transport);
    const b = Node.start('b@wsr', meshB.transport);
    let meshB2: ReturnType<typeof wsMeshTransport> | undefined;
    let b2: Node.NodeHandle | undefined;
    try {
      b.handle('hi', () => 'from-b');
      await settle();
      urls['a@wsr'] = `ws://127.0.0.1:${meshA.port()}`;
      urls['b@wsr'] = `ws://127.0.0.1:${meshB.port()}`;
      assert.true(await until(() => a.list().length === 1), 'pair connected');
      assert.equal(await tryCall(a, 'b@wsr', 'hi'), 'from-b', 'call works before the kill');

      // Sever every socket B's listener holds (a's dialed link dies) — the poll must re-dial.
      // Discovery drops the dead peer FIRST (exactly what cluster() would report), so the
      // survivor never wastes dials on a dead port.
      delete urls['b@wsr'];
      await meshB.close();
      meshB2 = wsMeshTransport('b@wsr', { port: 0, peers: () => urls, pollMs: 25 });
      b2 = Node.start('b@wsr2', meshB2.transport); // fresh node behind the new listener
      b2.handle('hi', () => 'from-b2');
      urls['b@wsr2'] = `ws://127.0.0.1:${meshB2.port()}`;

      assert.true(
        await until(() => a.list().includes('b@wsr2')),
        'the survivor re-dialed and discovered the replacement peer',
      );
      assert.equal(await tryCall(a, 'b@wsr2', 'hi'), 'from-b2', 'calls flow again after recovery');
    } finally {
      a.stop();
      b.stop();
      b2?.stop();
      await meshA.close();
      await meshB2?.close(); // a failed assertion must NOT leak listeners (it hung CI for 25min)
    }
  });
  test('attaches to an INJECTED http server (the wss/TLS path uses https the same way)', async (assert) => {
    const { createServer } = await import('node:http');
    const urls: Record<string, string> = {};
    const httpA = createServer();
    const httpB = createServer();
    await new Promise<void>((r) => httpA.listen(0, r));
    await new Promise<void>((r) => httpB.listen(0, r));
    const meshA = wsMeshTransport('a@wss', { server: httpA, peers: () => urls, pollMs: 25 });
    const meshB = wsMeshTransport('b@wss', { server: httpB, peers: () => urls, pollMs: 25 });
    const a = Node.start('a@wss', meshA.transport);
    const b = Node.start('b@wss', meshB.transport);
    try {
      b.handle('hi', () => 'from-b');
      urls['a@wss'] = `ws://127.0.0.1:${meshA.port()}`;
      urls['b@wss'] = `ws://127.0.0.1:${meshB.port()}`;
      assert.true(await until(() => a.list().length === 1), 'connected over the injected server');
      assert.equal(
        await tryCall(a, 'b@wss', 'hi'),
        'from-b',
        'routes over the bring-your-own server',
      );
    } finally {
      a.stop();
      b.stop();
      await meshA.close();
      await meshB.close();
      await new Promise<void>((r) => httpA.close(() => r())); // the server is OURS to close
      await new Promise<void>((r) => httpB.close(() => r()));
    }
  });
});
