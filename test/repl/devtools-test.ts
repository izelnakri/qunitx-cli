import { module, test } from 'qunitx';
import { WebSocket, WebSocketServer } from 'ws';
import { bridgeTo } from '../../lib/repl/devtools.ts';
import '../helpers/custom-asserts.ts';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for Chrome's debugger endpoint: echoes what it is told, prefixed.
 *
 * `slowly` holds the handshake open, which is the only way to be sure a message arrives before the
 * socket to Chrome is ready — the case the bridge has to hold rather than drop.
 */
async function upstream(slowly = 0): Promise<{ url: string; seen: string[]; close: () => void }> {
  const seen: string[] = [];
  const server = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (_info, accept) => void setTimeout(() => accept(true), slowly),
  });
  await new Promise((listening) => server.once('listening', listening));
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      seen.push(String(data));
      socket.send(`echo:${String(data)}`);
    });
  });

  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/page/ABC`,
    seen,
    close: () => server.close(),
  };
}

/** A frontend is a browser, and a browser always sends an Origin — the whole reason this exists. */
function frontend(address: string): WebSocket {
  return new WebSocket(`ws://${address}`, { headers: { Origin: 'http://localhost:9999' } });
}

/** The next message, or what it means that there wasn't one — a dropped relay must not hang. */
const answered = (socket: WebSocket) =>
  new Promise<string>((resolve) => {
    const gaveUp = setTimeout(() => resolve('(nothing came back)'), 4000);
    socket.once('message', (data) => {
      clearTimeout(gaveUp);
      resolve(String(data));
    });
  });

// Chrome answers 403 to any debugger connection carrying an Origin header, and the only flag that
// would lift that takes `*` — every origin, including whatever is open in your own browser. Node
// sends no Origin, so the frontend connects here and this connects onward.
module('Repl | devtools bridge', { concurrency: true }, () => {
  test('what the frontend sends reaches Chrome, and what Chrome answers comes back', async (assert) => {
    const chrome = await upstream();
    const bridge = await bridgeTo(chrome.url);
    const client = frontend(bridge.address);
    await new Promise((open) => client.once('open', open));

    client.send('{"id":1,"method":"Page.enable"}');
    const reply = await answered(client);

    assert.strictEqual(reply, 'echo:{"id":1,"method":"Page.enable"}', 'both ways');
    assert.deepEqual(chrome.seen, ['{"id":1,"method":"Page.enable"}'], 'verbatim, not re-encoded');
    client.close();
    await bridge.close();
    chrome.close();
  });

  test('a message sent before Chrome answered the phone is held, not dropped', async (assert) => {
    // A frontend starts talking the moment its own socket opens, which is before the socket to
    // Chrome has finished opening. The first message is the one asking what the page IS, and a
    // DevTools that never gets an answer to it shows an empty window.
    const chrome = await upstream(400);
    const bridge = await bridgeTo(chrome.url);
    const client = frontend(bridge.address);
    client.once('open', () => client.send('first'));

    assert.strictEqual(await answered(client), 'echo:first');
    client.close();
    await bridge.close();
    chrome.close();
  });

  test('closing one end closes the other, and closing the bridge stops it listening', async (assert) => {
    const chrome = await upstream();
    const bridge = await bridgeTo(chrome.url);
    const client = frontend(bridge.address);
    await new Promise((open) => client.once('open', open));
    const ended = new Promise((closed) => client.once('close', closed));

    await bridge.close();
    await ended;

    const refused = await new Promise<string>((resolve) => {
      const late = frontend(bridge.address);
      late.once('error', (error: Error) => resolve(error.message));
      late.once('open', () => resolve('still listening'));
    });

    assert.notStrictEqual(refused, 'still listening', `the port is gone — ${refused}`);
    chrome.close();
  });
});
