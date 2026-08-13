import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { collectMetrics } from '../../lib/node/metrics.ts';
import { Failure } from '../../lib/result/index.ts';

const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const Boom = Failure.define('Boom', 'kaboom');

module('Node | metrics (Prometheus sink)', () => {
  test('counts calls, errors, and timeouts from real traffic; renders Prometheus text', async (assert) => {
    const metrics = collectMetrics();
    try {
      const hub = Node.memoryHub();
      const server = Node.start('srv@metrics', hub.transport());
      const client = Node.start('cli@metrics', hub.transport());
      server.handle('ok', () => 'fine');
      server.handle('boom', () => Boom());
      await settle();

      await client.call('srv@metrics', 'ok');
      await client.call('srv@metrics', 'ok');
      await client.call('srv@metrics', 'boom').result(); // a declared-failure reply

      const snap = metrics.snapshot();
      assert.strictEqual(snap.callsStarted, 3, 'three calls initiated');
      assert.strictEqual(snap.callsCompleted, 3, 'three replies received');
      assert.strictEqual(snap.callErrors, 1, 'one of them was a declared failure');
      assert.strictEqual(snap.handled, 3, 'three inbound handler dispatches');
      assert.strictEqual(snap.duration.count, 3, 'three latency samples recorded');

      const text = metrics.prometheus();
      assert.true(text.includes('node_calls_total 3'), 'renders the calls counter');
      assert.true(text.includes('node_call_errors_total 1'), 'renders the errors counter');
      assert.true(
        text.includes('node_call_duration_ms_bucket{le="+Inf"} 3'),
        'renders the histogram with the +Inf bucket',
      );
      assert.true(
        text.includes('# TYPE node_call_duration_ms histogram'),
        'declares the histogram type',
      );

      server.stop();
      client.stop();
    } finally {
      metrics.stop();
    }
  });

  test('a call that times out increments the timeout counter', async (assert) => {
    const metrics = collectMetrics();
    try {
      const hub = Node.memoryHub();
      const client = Node.start('cli2@metrics', hub.transport());
      // No server owns this — a via call to an unowned key rejects fast (NotRegistered), so instead
      // address a dead node name and use a short deadline to force a real timeout path.
      await client.call('ghost@metrics', 'nope', undefined, 60).result();
      await settle(40);
      assert.strictEqual(metrics.snapshot().callTimeouts, 1, 'the timeout was counted');
      client.stop();
    } finally {
      metrics.stop();
    }
  });

  test('stop() detaches — no further counting', async (assert) => {
    const metrics = collectMetrics();
    const hub = Node.memoryHub();
    const server = Node.start('srv3@metrics', hub.transport());
    const client = Node.start('cli3@metrics', hub.transport());
    server.handle('ping', () => 'pong');
    await settle();
    await client.call('srv3@metrics', 'ping');
    const before = metrics.snapshot().callsCompleted;
    metrics.stop();
    await client.call('srv3@metrics', 'ping');
    assert.strictEqual(metrics.snapshot().callsCompleted, before, 'no counting after stop()');
    server.stop();
    client.stop();
  });
});
