import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import * as Telemetry from '../../lib/telemetry/index.ts';
import type { Trace } from '../../lib/node/index.ts';

module('Node | distributed tracing', () => {
  test('a call carries a trace; a nested call continues it (same id, parent = incoming span)', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@tr', hub.transport());
    const b = Node.start('b@tr', hub.transport());
    const c = Node.start('c@tr', hub.transport());
    const seen: { at: string; trace?: Trace }[] = [];

    c.handle('leaf', (_p, _from, meta) => {
      seen.push({ at: 'c', trace: meta?.trace });
      return 'done';
    });
    b.handle('mid', (_p, _from, meta) => {
      seen.push({ at: 'b', trace: meta?.trace });
      return b.call('c@tr', 'leaf'); // SYNCHRONOUS nested call — inherits the ambient trace
    });

    await a.call('b@tr', 'mid');
    const [atB, atC] = [seen.find((s) => s.at === 'b')!, seen.find((s) => s.at === 'c')!];
    assert.ok(atB.trace?.id, 'the first hop carries a trace id');
    assert.equal(atC.trace?.id, atB.trace?.id, 'the nested hop stays in the SAME trace');
    assert.equal(
      atC.trace?.parent,
      atB.trace?.span,
      "the nested hop's parent is the incoming span",
    );
    a.stop();
    b.stop();
    c.stop();
  });

  test('withTrace threads a trace through an ASYNC handler continuation', async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@tr', hub.transport());
    const b = Node.start('b@tr', hub.transport());
    const c = Node.start('c@tr', hub.transport());
    let leafTrace: Trace | undefined;
    c.handle('leaf', (_p, _f, meta) => ((leafTrace = meta?.trace), 'ok'));
    b.handle('mid', async (_p, _f, meta) => {
      await new Promise((r) => setTimeout(r, 5)); // the ambient window is gone after this await
      return b.withTrace(meta?.trace, () => b.call('c@tr', 'leaf'));
    });

    await a.call('b@tr', 'mid');
    assert.ok(leafTrace?.id, 'the async continuation still carried a trace');
    a.stop();
    b.stop();
    c.stop();
  });

  test("telemetry ['node','call','stop'] carries the trace and a duration", async (assert) => {
    const hub = Node.memoryHub();
    const a = Node.start('a@tr', hub.transport());
    const b = Node.start('b@tr', hub.transport());
    b.handle('work', () => 42);
    const stops: { duration: number; trace?: Trace }[] = [];
    Telemetry.attach('trace-test', ['node', 'call', 'stop'], (_e, m, meta) =>
      stops.push({ duration: m.duration, trace: meta.trace as Trace }),
    );

    await a.call('b@tr', 'work');
    Telemetry.detach('trace-test');
    assert.equal(stops.length, 1, 'one stop event for one call');
    assert.true(stops[0].duration >= 0, 'a measured duration');
    assert.ok(stops[0].trace?.id, 'the trace rode the telemetry event');
    a.stop();
    b.stop();
  });
});
