/**
 * Injected verbatim into the browser test-page runtime via `.toString()`, so this
 * MUST stay dependency-free plain JS (no imports, no TS types).
 *
 * Manages a single test-page WebSocket with a connect-retry that fires ONLY on the
 * terminal 'close' before a successful 'open' — never on the informational 'error'
 * (which always precedes 'close'). Retrying on 'error' opened a second socket while
 * the first was still completing its handshake server-side, so one page load produced
 * two accepted connections; QUnit then sent testEnd/done on window.socket, and if that
 * pointed at the abandoned socket the 'done' was silently dropped and the run hung
 * (the 2× WS-connection flake seen on slow browsers / webkit under watch re-runs).
 *
 * WebSocketCtor and setTimeoutFn are injected so the retry state machine is unit-
 * testable without a real browser (see test/setup/ws-client-test.ts).
 */
export function createReconnectingSocket(options) {
  let retryCount = 0;
  let opened = false;
  let current = null;

  function connect() {
    // Abandon any previous socket: detach its listeners BEFORE close() so the 'close'
    // we trigger here cannot re-enter retry and spawn a cascade of sockets.
    if (current) {
      current.onopen = current.onclose = current.onerror = current.onmessage = null;
      try {
        current.close();
      } catch (_error) {
        /* already closed */
      }
    }
    let socket;
    try {
      socket = new options.WebSocketCtor(options.url);
    } catch (_error) {
      retry();
      return null;
    }
    current = socket;
    options.onSocket(socket);

    socket.onopen = function () {
      opened = true;
      options.onOpen(socket);
    };
    // Retry only the current socket, and only if it never opened — so a normal
    // end-of-run close does not reconnect (watch re-runs get a fresh socket via reload).
    socket.onclose = function () {
      if (socket === current && !opened) retry();
    };
    socket.onmessage = function (event) {
      options.onMessage(socket, event);
    };
    return socket;
  }

  function retry() {
    if (retryCount++ >= options.maxRetries) {
      if (options.onExhausted) options.onExhausted();
      return;
    }
    options.setTimeoutFn(connect, options.retryIntervalMs);
  }

  return { connect: connect };
}
