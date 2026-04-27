import net from 'node:net';

/**
 * Reads NDJSON from `socket`, dispatching each parsed object via `onLine`.
 * Tolerates packet splits across line boundaries; silently drops malformed lines.
 * Used by both the daemon server (parsing client requests) and the client
 * (parsing server responses).
 */
export function attachLineParser<T>(socket: net.Socket, onLine: (line: T) => void): void {
  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      try {
        onLine(JSON.parse(line) as T);
      } catch {
        /* malformed line — skip */
      }
    }
  });
}

/**
 * Attempts a connection to the given path (POSIX socket or Windows named pipe).
 * Resolves the connected socket on success, `null` on any failure (peer absent,
 * ECONNREFUSED, ENOENT, timeout). Lets `net.createConnection` produce the error
 * directly — a pre-emptive `existsSync` check would not work for Windows named
 * pipes (they live in `\\.\pipe\...`, not on the regular filesystem).
 */
export function probeSocket(socketPath: string, timeoutMs: number): Promise<net.Socket | null> {
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
