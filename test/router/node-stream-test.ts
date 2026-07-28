import { module, test } from 'qunitx';
import { router, json } from '../../lib/router/index.ts';
import { nodeListen } from '../../lib/router/node.ts';

// The Node binding must STREAM response bodies (SSE, large payloads) — not buffer them. The
// proof: the client observes chunk 1 while the server hasn't produced chunk 2 yet; a buffering
// binding cannot deliver anything until the whole body exists.
module('Router | Node binding streams', () => {
  test('a chunk reaches the client BEFORE the server produces the next one', async (assert) => {
    const app = router();
    let releaseSecond: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseSecond = r));
    const encoder = new TextEncoder();
    app.get('/events', () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode('data: first\n\n'));
          await gate; // the second chunk does not exist until the test releases it
          controller.enqueue(encoder.encode('data: second\n\n'));
          controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const server = nodeListen(app, 0);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port()}/events`);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      const first = await reader.read(); // arrives while chunk 2 is still ungated
      assert.true(
        decoder.decode(first.value).includes('first'),
        'the first chunk streamed through before the body was complete',
      );

      releaseSecond();
      let rest = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += decoder.decode(value);
      }
      assert.true(rest.includes('second'), 'the remainder followed after the gate opened');
    } finally {
      await server.close();
    }
  });

  test('bodyless and JSON responses still work through the streaming path', async (assert) => {
    const app = router();
    app.get('/none', () => new Response(null, { status: 204 }));
    app.get('/data', () => json({ ok: true }));
    const server = nodeListen(app, 0);
    try {
      const none = await fetch(`http://127.0.0.1:${server.port()}/none`);
      assert.equal(none.status, 204, 'a bodyless response ends cleanly');
      const data = await fetch(`http://127.0.0.1:${server.port()}/data`);
      assert.deepEqual(await data.json(), { ok: true }, 'a JSON body round-trips');
    } finally {
      await server.close();
    }
  });
});
