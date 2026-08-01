import { module, test } from 'qunitx';
import net from 'node:net';
import { createSemaphoreServer } from './semaphore-server.ts';

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

// Budget for a grant that MUST arrive. Generous on purpose: these assertions are about a slot
// being recoverable at all, never about latency, and a loaded CI runner (16 workers, each with
// a browser) can stall a loopback round-trip well past any "surely that's enough" figure.
// A negative assertion is the opposite case — there a short budget is correct, since a slow
// machine only makes "still not granted" more true.
const GRANT_BUDGET_MS = 5000;

// Polls until `condition` holds, or throws when `GRANT_BUDGET_MS` elapses. Waiting for the
// state the next step depends on is what makes the interleaving deterministic instead of
// merely likely.
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + GRANT_BUDGET_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await delay(1);
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

module('Helpers | SemaphoreServer', { concurrency: true }, () => {
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

      // Queue a second connection, then destroy it before it is granted. Waiting for the
      // server to actually hold the queue entry is load-bearing: if the destroy lands first
      // the queue is empty and the run proves nothing, which a fixed sleep cannot rule out.
      const s2 = queueSlot(sem.port);
      await until(() => sem.stats().queued === 1, 'the server has queued the second connection');

      // Both waits are load-bearing, and for different reasons. The first proves the socket
      // really is queued (destroy landing first would leave an empty queue and prove nothing).
      // The second pins the ONE interleaving the historical bug needed: the server must have
      // PROCESSED the death before the slot frees, so the later grant() meets an already-dead
      // socket whose close will never come again. Reversed, the close handler returns the slot
      // on its own and even the buggy server looks correct.
      const closesBefore = sem.stats().closes;
      s2.destroy();
      await until(
        () => sem.stats().closes > closesBefore,
        "the server has processed the queued socket's close",
      );

      // Release the active slot. Whether or not the server has processed s2's close by now,
      // the slot must come back: grant() either skips the destroyed socket and passes the
      // capacity on, or hands it over and the close that follows returns it. The buggy
      // version did neither — it wrote to a dead socket and leaked the slot for good.
      s1.destroy();

      const grantedAfterRecovery = await tryAcquireWithinMs(sem.port, GRANT_BUDGET_MS);
      assert.true(
        grantedAfterRecovery,
        'a new connection is granted again — the dead queued socket cost no slot',
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
      const granted = await tryAcquireWithinMs(sem.port, GRANT_BUDGET_MS);
      assert.true(granted, 'server still grants slots after 10 cycles');
    } finally {
      await sem.close();
    }
  });
});
