import net from 'node:net';
import { availableParallelism } from 'node:os';
import { writeFile } from 'node:fs/promises';

// Each Chrome instance spawns multiple OS processes (browser, renderer, GPU).
// Cap at availableParallelism() and let the OS scheduler handle the rest.
const MAX_CONCURRENT = availableParallelism();
let slots = MAX_CONCURRENT;
const waiting = [];
let activeConnections = 0;
let idleTimer = null;

// Exit after 10s idle (all tests done, no connections remaining)
function scheduleIdleExit() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => server.close(() => process.exit(0)), 10000);
}

const server = net.createServer((socket) => {
  activeConnections++;
  clearTimeout(idleTimer);

  let buffer = '';

  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const cmd = line.trim();
      if (cmd === 'acquire') {
        if (slots > 0) {
          slots--;
          socket.write('ok\n');
        } else {
          waiting.push(() => {
            slots--;
            socket.write('ok\n');
          });
        }
      } else if (cmd === 'release') {
        if (waiting.length > 0) {
          waiting.shift()();
        } else {
          slots++;
        }
        socket.write('ok\n');
      }
    }
  });

  socket.on('close', () => {
    activeConnections--;
    if (activeConnections === 0) scheduleIdleExit();
  });

  socket.on('error', () => {});
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  // Write port to file so parent process can read it without keeping a pipe open.
  await writeFile(process.argv[2], String(port));
  scheduleIdleExit();
});
