// The BROWSER demo — the whole stack to a real browser tab. One process runs a durable room
// host + a channel gateway; an http server serves a chat page whose client bundle is the REAL
// library (channelClient + webSocketWire, esbuild-bundled at startup); the page joins
// `room:lobby` over a live WebSocket, sends messages, and shows who's present.
//
//   node src/browser-demo.ts        # then open the printed http://localhost:<port>
//
// Everything the page exercises is the production path: join auth → Presence track, message →
// durable room actor (persist-before-ack) → PubSub broadcast → push to every joined socket.
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { build } from 'esbuild';
import * as Node from '../../../lib/node/index.ts';
import { serveChannelsOverWs } from '../../../lib/channel/ws.ts';
import { chatGateway, startRoomHost } from './chat-channels.ts';

const PAGE = (wsPort: number): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>qunitx chat — the realtime stack, end to end</title>
<style>
  body { font: 15px/1.4 system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  #log { border: 1px solid #ccc; border-radius: 6px; padding: .75rem; height: 260px; overflow-y: auto; }
  #log p { margin: .2rem 0; }
  #who { color: #666; font-size: .85rem; margin: .5rem 0; }
  form { display: flex; gap: .5rem; margin-top: .75rem; }
  input[type=text] { flex: 1; padding: .45rem; }
</style>
</head>
<body>
<h1>#lobby</h1>
<p id="who">connecting…</p>
<div id="log"></div>
<form id="say"><input type="text" id="text" placeholder="say something" autocomplete="off" /><button>send</button></form>
<script>window.__WS_URL__ = 'ws://' + location.hostname + ':' + ${wsPort};</script>
<script type="module" src="/client.js"></script>
</body>
</html>`;

// The browser entry, bundled from the REAL library at startup — no hand-rolled protocol.
// (Resolved relative to this file's directory via esbuild's resolveDir.)
const CLIENT_ENTRY = `
import { channelClient, webSocketWire } from '../../../lib/channel/index.ts';

const user = 'guest-' + Math.random().toString(36).slice(2, 7);
const log = document.getElementById('log');
const who = document.getElementById('who');
const say = (line) => {
  const p = document.createElement('p');
  p.textContent = line;
  log.append(p);
  log.scrollTop = log.scrollHeight;
};

const client = channelClient({
  connect: () => webSocketWire(window.__WS_URL__),
  onReconnect: () => say('· reconnected'),
});
client.on('room:lobby', 'message', (m) => say(m.user + ': ' + m.text));

await client.join('room:lobby', { user });
const refresh = async () => {
  const { reply } = await client.push('room:lobby', 'presence');
  who.textContent = 'you are ' + user + ' — ' + Object.keys(reply).length + ' here';
};
await refresh();
setInterval(refresh, 3000);

document.getElementById('say').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('text');
  if (input.value.trim()) client.push('room:lobby', 'message', { user, text: input.value.trim() });
  input.value = '';
});
`;

/** Boot the whole demo; returns the two ports and a full teardown (used by the test, too). */
export async function startBrowserDemo(options: { httpPort?: number; wsPort?: number } = {}) {
  const hub = Node.memoryHub();
  const store = Node.memoryStore();
  const host = startRoomHost('host@browser-chat', hub.transport(), store);
  const gwNode = Node.start('gw@browser-chat', hub.transport());
  const gateway = chatGateway(gwNode);
  const edge = serveChannelsOverWs(gateway, { port: options.wsPort ?? 0 });

  // Bundle the browser client from the real library once, up front.
  const bundle = await build({
    stdin: {
      contents: CLIENT_ENTRY,
      resolveDir: dirname(fileURLToPath(import.meta.url)),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    write: false,
  });
  const clientJs = bundle.outputFiles[0].text;

  const http = createServer((req, res) => {
    if (req.url === '/client.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(clientJs);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE(edge.port()));
    }
  });
  await new Promise<void>((ready) => http.listen(options.httpPort ?? 0, ready));

  return {
    httpPort: (http.address() as { port: number }).port,
    wsPort: edge.port(),
    close: async () => {
      http.close();
      await edge.close();
      await host.stop();
      gwNode.stop();
    },
  };
}

// Run directly: boot and print the URL.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const demo = await startBrowserDemo();
  console.log(`chat is live: http://localhost:${demo.httpPort} (ws on :${demo.wsPort})`);
}
