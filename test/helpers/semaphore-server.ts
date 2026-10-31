import net from 'node:net';

export interface SemaphoreServer {
  port: number;
  close(): Promise<void>;
  /**
   * Live counts, for tests that must wait until the server has actually reached a state.
   * `closes` counts every socket whose `close` the server has PROCESSED — the only way to
   * pin the interleaving this server's one historical bug depended on (a queued socket whose
   * death is seen before the slot it was waiting on is released).
   * The protocol gives a queued client no reply of its own — being queued is precisely the
   * absence of one — so from the outside a sleep is the only alternative, and a sleep that is
   * too short on a loaded runner silently tests the wrong interleaving rather than failing.
   */
  stats(): { active: number; queued: number; closes: number };
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
export async function createSemaphoreServer(max: number): Promise<SemaphoreServer> {
  // Each holder's weight: a slot, or several for a client that holds several browsers at once.
  const holders = new Map<net.Socket, number>();
  const queue: { socket: net.Socket; weight: number; grant: () => void }[] = [];
  let used = 0;
  let closes = 0;
  // An idle server takes any request, however heavy, so a weight above `max` still runs, alone.
  const fits = (weight: number) => used === 0 || used + weight <= max;
  // First come, first served: a waiter is never overtaken by a lighter one behind it, so a heavy
  // request cannot be starved by a stream of light ones. A waiter that died is passed over.
  const drain = () => {
    for (
      let head = queue[0];
      head && (head.socket.destroyed || fits(head.weight));
      head = queue[0]
    ) {
      queue.shift();
      if (!head.socket.destroyed) head.grant();
    }
  };

  const server = net.createServer((socket) => {
    // Prevent uncaught 'error' events from crashing the semaphore server.
    // Loopback sockets rarely error, but without a listener Node.js throws unconditionally.
    socket.on('error', () => {});

    socket.once('close', () => {
      closes += 1;
      const weight = holders.get(socket);
      if (weight !== undefined) {
        holders.delete(socket);
        used -= weight;
      }
      // A waiter that died frees nothing, but may have been the head of the line.
      drain();
    });

    socket.once('data', (data) => {
      // A digit asks for that many slots; anything else is one.
      const asked = Number.parseInt(data.toString('latin1', 0, 1), 10);
      const weight = Number.isInteger(asked) && asked > 0 ? Math.min(asked, max) : 1;
      const grant = () => {
        holders.set(socket, weight);
        used += weight;
        socket.write('ok');
      };
      if (!queue.length && fits(weight)) grant();
      else queue.push({ socket, weight, grant });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
    stats: () => ({ active: holders.size, queued: queue.length, closes }),
  };
}
