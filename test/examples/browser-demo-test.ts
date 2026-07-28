import { module, test } from 'qunitx';
import { startBrowserDemo } from '../../examples/realtime-chat/src/browser-demo.ts';
import { channelClient, webSocketWire } from '../../lib/channel/index.ts';

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

// The demo the browser loads, verified end to end: the page is served, the client bundle BUILDS
// from the real library, and the exact protocol the page speaks works against the live edge.
module('Examples | browser chat demo', () => {
  test('serves the page + a real client bundle, and the page protocol round-trips', async (assert) => {
    const demo = await startBrowserDemo();

    const html = await (await fetch(`http://127.0.0.1:${demo.httpPort}/`)).text();
    assert.true(html.includes('qunitx chat'), 'the chat page is served');
    assert.true(html.includes(`${demo.wsPort}`), 'the page carries the live ws port');

    const clientJs = await (await fetch(`http://127.0.0.1:${demo.httpPort}/client.js`)).text();
    assert.true(clientJs.includes('join'), 'the browser bundle built from the real library');
    assert.true(clientJs.length > 1000, 'and is a real bundle, not a stub');

    // Speak the page's exact protocol over the live socket: join → presence → message broadcast.
    const seen: unknown[] = [];
    const client = channelClient({
      connect: () => webSocketWire(`ws://127.0.0.1:${demo.wsPort}`),
      heartbeatMs: false,
    });
    client.on('room:lobby', 'message', (m) => seen.push(m));
    assert.deepEqual(await client.join('room:lobby', { user: 'ada' }), { ok: true }, 'joined');

    const presence = (await client.push('room:lobby', 'presence')) as {
      reply: Record<string, unknown>;
    };
    assert.equal(Object.keys(presence.reply).length, 1, 'presence shows the joined client');

    void client.push('room:lobby', 'message', { user: 'ada', text: 'hello browser' });
    await settle(150); // durable append + broadcast round-trip
    assert.deepEqual(
      (seen as { text: string }[]).map((m) => m.text),
      ['hello browser'],
      'the message came back as a broadcast push — durable actor + PubSub + socket, end to end',
    );

    client.close();
    await demo.close();
  });
});
