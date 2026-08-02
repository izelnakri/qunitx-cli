import net from 'node:net';
import * as Result from '../../result/index.ts';

/**
 * Reads NDJSON from `socket`, dispatching each parsed object via `onLine`.
 * Tolerates packet splits across line boundaries; silently drops malformed lines.
 * Used by both the daemon server (parsing client requests) and the client
 * (parsing server responses).
 *
 * ```ts
 * import * as Socket from './socket.ts';
 *
 * import net from 'node:net';
 * import { Buffer } from 'node:buffer';
 * const seen: Array<{ type: string }> = [];
 * const sock = new net.Socket();
 * Socket.readMessages<{ type: string }>(sock, (msg) => seen.push(msg));
 * sock.emit('data', Buffer.from('{"type":"ping"}\nnot-json\n'));
 * seen; // [{ type: 'ping' }] — the malformed line is dropped
 * ```
 */
export function readMessages<T>(socket: net.Socket, onLine: (line: T) => void): void {
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      // Only the parse is guarded. The old `try` wrapped `onLine` as well, so an exception
      // thrown by the CONSUMER — a real bug — was indistinguishable from a torn frame and
      // silently dropped. Measured: against JSON.parse itself the guard is not the cost.
      // Parsed as `unknown` and cast at the call: `Result.try(() => … as T)` with an
      // unresolved `T` leaves `Tried<T>` undecidable, so the outcome types as a union that
      // includes the promise branch and `.ok` stops existing.
      const message = Result.try(() => JSON.parse(line));
      if (message.ok) onLine(message.value as T);
    }
  });
}

/**
 * Attempts a connection to the given path (POSIX socket or Windows named pipe).
 * Resolves the connected socket on success, `null` on any failure (peer absent,
 * ECONNREFUSED, ENOENT, timeout). Lets `net.createConnection` produce the error
 * directly — a pre-emptive `existsSync` check would not work for Windows named
 * pipes (they live in `\\.\pipe\...`, not on the regular filesystem).
 *
 * ```ts
 * import * as Socket from './socket.ts';
 *
 * // Defined, not invoked: dials a Unix socket / named pipe.
 * async function dialDaemon() {
 *   return await Socket.connect('/tmp/qunitx-daemon-ab12cd34ef56.sock', 1_000); // net.Socket, or null
 * }
 * ```
 */
export function connect(socketPath: string, timeoutMs: number): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(null);
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}
