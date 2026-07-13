import { module, test } from 'qunitx';
import { createReconnectingSocket } from '../../lib/setup/ws-client.js';

// Drives the injected browser WS controller with a mock WebSocket + mock timer, so
// the connect-retry state machine is verified deterministically without a browser.
// This reproduces the "2× WS connection" edge case that hung watch re-runs on webkit:
// a transient 'error' fired during the handshake, before 'open'.
function harness() {
  const sockets: MockSocket[] = [];
  const timers: Array<() => void> = [];

  class MockSocket {
    url: string;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: unknown) => void) | null = null;
    closed = false;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  const opened: MockSocket[] = [];
  const controller = createReconnectingSocket({
    url: 'ws://localhost:1234',
    maxRetries: 5,
    retryIntervalMs: 10,
    WebSocketCtor: MockSocket,
    setTimeoutFn: (fn: () => void) => timers.push(fn),
    onSocket: () => {},
    onOpen: (s: MockSocket) => opened.push(s),
    onMessage: () => {},
    onExhausted: () => {},
  });

  return {
    sockets,
    timers,
    opened,
    connect: () => controller.connect(),
    flushTimers: () => timers.splice(0).forEach((fn) => fn()),
  };
}

module('Setup | ws-client reconnect', { concurrency: true }, () => {
  test('a transient error before open does NOT open a second socket (the webkit flake)', (assert) => {
    const h = harness();
    h.connect();
    assert.equal(h.sockets.length, 1, 'one socket created');
    // The informational 'error' the runtime used to retry on — now ignored.
    h.sockets[0].onerror?.();
    assert.equal(h.timers.length, 0, 'no retry scheduled on error');
    // The handshake then succeeds on the SAME socket.
    h.sockets[0].onopen?.();
    assert.equal(h.sockets.length, 1, 'still exactly one connection from this page load');
    assert.equal(h.opened.length, 1);
  });

  test('close before open retries with exactly one new socket', (assert) => {
    const h = harness();
    h.connect();
    h.sockets[0].onclose?.(); // terminal failure before opening
    assert.equal(h.timers.length, 1, 'retry scheduled on the terminal close');
    h.flushTimers();
    assert.equal(h.sockets.length, 2, 'one replacement socket');
    h.sockets[1].onopen?.();
    assert.equal(h.opened.length, 1);
  });

  test('close AFTER a successful open does not reconnect (normal end of run)', (assert) => {
    const h = harness();
    h.connect();
    h.sockets[0].onopen?.();
    h.sockets[0].onclose?.();
    assert.equal(h.timers.length, 0, 'a clean end-of-run close never reconnects');
  });

  test('abandoning a socket for a fresh connect detaches its listeners (no retry cascade)', (assert) => {
    const h = harness();
    h.connect();
    const first = h.sockets[0];
    h.connect(); // supersede: e.g. a retry firing
    assert.equal(first.onclose, null, 'abandoned socket close handler detached');
    assert.true(first.closed, 'abandoned socket closed');
    assert.equal(h.timers.length, 0, 'detached close cannot schedule a retry');
  });

  test('stops after maxRetries and reports exhaustion', (assert) => {
    let exhausted = 0;
    const sockets: Array<{ onclose: (() => void) | null }> = [];
    const timers: Array<() => void> = [];
    class MockSocket {
      onopen = null;
      onclose: (() => void) | null = null;
      onerror = null;
      onmessage = null;
      constructor() {
        sockets.push(this);
      }
      close() {}
    }
    const controller = createReconnectingSocket({
      url: 'ws://x',
      maxRetries: 2,
      retryIntervalMs: 1,
      WebSocketCtor: MockSocket,
      setTimeoutFn: (fn: () => void) => timers.push(fn),
      onSocket: () => {},
      onOpen: () => {},
      onMessage: () => {},
      onExhausted: () => {
        exhausted += 1;
      },
    });
    controller.connect();
    // Each real failure is a fresh socket's close; stop once retrying no longer
    // produces a new socket (mirrors reality — a closed socket never re-fires).
    for (let i = 0; i < 10; i += 1) {
      const before = sockets.length;
      sockets.at(-1)!.onclose?.();
      timers.splice(0).forEach((fn) => fn());
      if (sockets.length === before) break;
    }
    assert.equal(sockets.length, 3, 'initial socket + maxRetries retries, then no more');
    assert.equal(exhausted, 1, 'onExhausted fires once past the retry budget');
  });
});
