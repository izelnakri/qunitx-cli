import { module, test } from 'qunitx';
import { bindServerToPort } from '../../lib/setup/bind-server-to-port.ts';
import type { HTTPServer } from '../../lib/web/index.ts';

// The retry logic used to be covered only by a real-port integration test that held a port,
// released it, and expected the CLI to reclaim it. Under the 16-worker parallel suite that port
// gets grabbed by another worker in the release window, so the CLI legitimately failed and the
// test flaked (CI run 29783893187, ubuntu). These unit tests drive the loop with a stub server —
// deterministic, no real sockets, no cross-worker contention — and an instant sleep.

const eaddrinuse = () => Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
const noSleep = () => Promise.resolve();

/** A server stub whose `listen(port)` outcome is decided per attempt by `plan`. */
function stubServer(plan: (port: number, attempt: number) => 'bind' | Error) {
  let attempts = 0;
  let boundPort = 0;
  const server = {
    listen(port: number) {
      const outcome = plan(port, attempts++);
      if (outcome === 'bind') {
        boundPort = port;
        return Promise.resolve();
      }
      return Promise.reject(outcome);
    },
    _server: { address: () => ({ port: boundPort }) },
  } as unknown as HTTPServer;
  return {
    server,
    get attempts() {
      return attempts;
    },
  };
}

module('Setup | bindServerToPort', { concurrency: true }, () => {
  test('explicit port: retries past a transient EADDRINUSE and binds the same port', async (assert) => {
    // Occupied for the first two attempts (the TOCTOU window), then free.
    const stub = stubServer((_port, attempt) => (attempt < 2 ? eaddrinuse() : 'bind'));
    const config = { port: 4000, portExplicit: true };

    await bindServerToPort(stub.server, config, noSleep);

    assert.equal(stub.attempts, 3, 'two failures then a successful bind');
    assert.equal(config.port, 4000, 'the same explicit port is kept, not incremented');
  });

  test('explicit port: a persistently occupied port exhausts retries and throws', async (assert) => {
    const stub = stubServer(() => eaddrinuse());
    const config = { port: 4000, portExplicit: true };

    await assert.rejects(
      bindServerToPort(stub.server, config, noSleep),
      'a port held the whole time still fails',
    );
    // Initial attempt + EXPLICIT_PORT_RETRIES (20) before giving up.
    assert.equal(stub.attempts, 21, 'tried once then retried the full budget');
  });

  test('auto port: increments past occupied ports until one is free', async (assert) => {
    // 1234 and 1235 taken, 1236 free. portExplicit falsy → increment, never retry the same port.
    const stub = stubServer((port) => (port < 1236 ? eaddrinuse() : 'bind'));
    const config = { port: 1234 };

    await bindServerToPort(stub.server, config, noSleep);

    assert.equal(stub.attempts, 3, 'walked 1234 → 1235 → 1236');
    assert.equal(config.port, 1236, 'config.port reflects the port actually bound');
  });

  test('a non-EADDRINUSE error is fatal and thrown immediately, without retrying', async (assert) => {
    const stub = stubServer(() => Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    const config = { port: 4000, portExplicit: true };

    await assert.rejects(
      bindServerToPort(stub.server, config, noSleep),
      'permission errors bubble',
    );
    assert.equal(stub.attempts, 1, 'no retry for an error that is not a transient collision');
  });
});
