import net from 'node:net';

export interface SemaphoreServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Creates a TCP semaphore server that caps concurrent browser-holding slots at `max`.
 *
 * Protocol: client opens a TCP connection and writes any byte. The server replies 'ok'
 * when a slot is available. The slot is held until the client's socket closes.
 *
 * Used by test/runner.ts to cap concurrent Chrome/Firefox/WebKit instances across all
 * parallel test workers. The same function is directly tested by test/setup/semaphore-test.ts.
 */
export default async function createSemaphoreServer(max: number): Promise<SemaphoreServer> {
  const holders = new Set<net.Socket>();
  const queue: Array<() => void> = [];

  const server = net.createServer((socket) => {
    // Prevent uncaught 'error' events from crashing the semaphore server.
    // Loopback sockets rarely error, but without a listener Node.js throws unconditionally.
    socket.on('error', () => {});

    socket.once('close', () => {
      if (!holders.delete(socket)) return; // was never granted — no-op
      queue.shift()?.();
    });

    const grant = () => {
      if (socket.destroyed) {
        // Socket died while waiting in the queue. Its 'close' event already fired
        // and holders.delete was a no-op. Pass the freed capacity on to the next waiter
        // so no slot is permanently lost.
        queue.shift()?.();
        return;
      }
      holders.add(socket);
      socket.write('ok');
    };

    socket.once('data', () => (holders.size < max ? grant() : queue.push(grant)));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
