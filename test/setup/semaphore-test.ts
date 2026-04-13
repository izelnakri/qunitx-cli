import { module, test } from 'qunitx';
import net from 'node:net';
import createSemaphoreServer from '../helpers/semaphore-server.ts';

// Connects to the semaphore server, writes the request byte, and resolves once
// the server replies 'ok'. Returns the socket so the caller can call .destroy()
// to release the slot (or simulate a crash).
function acquireSlot(port: number): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.once('error', reject);
    socket.once('data', () => resolve(socket));
    socket.write('r');
  });
}

// Connects and queues (does NOT wait for 'ok'). Returns the socket.
function queueSlot(port: number): net.Socket {
  const socket = net.createConnection({ port, host: '127.0.0.1' });
  socket.on('error', () => {});
  socket.write('r');
  return socket;
}

// Waits up to `ms` for a slot grant, resolves true/false. Used to distinguish
// "granted promptly" from "stuck in queue forever" in correctness assertions.
function tryAcquireWithinMs(port: number, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, ms);
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    socket.once('data', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.write('r');
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

module('Setup | SemaphoreServer', { concurrency: true }, () => {
  test('grants a slot immediately when under the concurrency limit', async (assert) => {
    const sem = await createSemaphoreServer(2);
    try {
      const granted = await tryAcquireWithinMs(sem.port, 2000);
      assert.true(granted, 'first connection receives ok within 2000 ms');
    } finally {
      await sem.close();
    }
  });

  test('grants up to max concurrent slots and queues the rest', async (assert) => {
    const sem = await createSemaphoreServer(2);
    try {
      const s1 = await acquireSlot(sem.port);
      const s2 = await acquireSlot(sem.port);

      // Third connection must queue — should NOT receive ok within 100 ms.
      const grantedWhileFull = await tryAcquireWithinMs(sem.port, 100);
      assert.false(grantedWhileFull, 'third connection is queued while both slots are taken');

      s1.destroy();
      s2.destroy();
    } finally {
      await sem.close();
    }
  });

  test('queued connection receives a slot once an active holder releases', async (assert) => {
    const sem = await createSemaphoreServer(1);
    try {
      const s1 = await acquireSlot(sem.port);

      // Queue a second connection.
      const s2Grant = acquireSlot(sem.port);

      // Release s1 — the server should now grant s2.
      s1.destroy();
      const s2 = await s2Grant;
      assert.ok(s2, 'queued connection receives ok after the active holder releases');
      s2.destroy();
    } finally {
      await sem.close();
    }
  });

  // ── Race condition: queued socket dies before being granted ───────────────────
  //
  // Bug in previous runner.ts logic: if a socket died while waiting in the queue,
  // grant() would still be called for it later (when a slot freed). The old code
  // had no socket.destroyed guard, so it called socket.write('ok') on a destroyed
  // socket, which:
  //   1. Emitted an uncaught 'error' event (no error handler) — could crash the runner.
  //   2. Incremented `active` without a matching `active--`, permanently losing one slot.
  //
  // After the fix the slot is correctly passed on and the server stays healthy.
  test('slot is not permanently lost when a queued socket is destroyed before being granted', async (assert) => {
    const sem = await createSemaphoreServer(1);
    try {
      // Fill the only slot.
      const s1 = await acquireSlot(sem.port);

      // Queue a second connection, then immediately destroy it before it is granted.
      const s2 = queueSlot(sem.port);
      await delay(20); // let the server register the queue entry
      s2.destroy();
      await delay(20); // let the server see the close

      // Release the active slot. The server must detect s2.destroyed, skip the write,
      // and NOT increment active — leaving active = 0 so the next connection can get in.
      s1.destroy();
      await delay(20); // let the server process the release + dead-socket grant

      // A new connection should be granted immediately (active = 0 < max = 1).
      const grantedAfterRecovery = await tryAcquireWithinMs(sem.port, 200);
      assert.true(
        grantedAfterRecovery,
        'a new connection is immediately granted after the server correctly skips the dead queued socket',
      );
    } finally {
      await sem.close();
    }
  });

  // ── Multiple chained releases drain the queue correctly ──────────────────────
  test('multiple queued connections are each granted in order as slots free', async (assert) => {
    const sem = await createSemaphoreServer(1);
    try {
      const s1 = await acquireSlot(sem.port);

      // Queue two more connections in sequence.
      const s2Promise = acquireSlot(sem.port);
      const s3Promise = acquireSlot(sem.port);

      // Release s1 → s2 should be granted.
      s1.destroy();
      const s2 = await s2Promise;
      assert.ok(s2, 's2 granted after s1 releases');

      // Release s2 → s3 should be granted.
      s2.destroy();
      const s3 = await s3Promise;
      assert.ok(s3, 's3 granted after s2 releases');
      s3.destroy();
    } finally {
      await sem.close();
    }
  });

  test('server remains healthy after many sequential grant/release cycles', async (assert) => {
    const sem = await createSemaphoreServer(2);
    try {
      for (let i = 0; i < 10; i++) {
        const s1 = await acquireSlot(sem.port);
        const s2 = await acquireSlot(sem.port);
        s1.destroy();
        s2.destroy();
        await delay(5);
      }
      const granted = await tryAcquireWithinMs(sem.port, 200);
      assert.true(granted, 'server still grants slots after 10 cycles');
    } finally {
      await sem.close();
    }
  });
});
