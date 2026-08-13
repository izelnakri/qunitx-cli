import { module, test } from 'qunitx';
import * as Telemetry from '../../lib/telemetry/index.ts';

// :telemetry is a global bus; each test uses unique event names + handler ids and detaches, so
// tests never see each other's handlers.
module('Telemetry | :telemetry bus', () => {
  test('execute delivers event, measurements, metadata, and config to the handler', (assert) => {
    const calls: unknown[] = [];
    Telemetry.attach(
      't1',
      ['app', 'call'],
      (event, m, meta, config) => void calls.push({ event, m, meta, config }),
      { sink: 'x' },
    );
    Telemetry.execute(['app', 'call'], { duration: 12 }, { subject: 'ping' });
    Telemetry.detach('t1');

    assert.deepEqual(calls, [
      {
        event: ['app', 'call'],
        m: { duration: 12 },
        meta: { subject: 'ping' },
        config: { sink: 'x' },
      },
    ]);
  });

  test('a handler only fires for its exact event', (assert) => {
    let hits = 0;
    Telemetry.attach('t2', ['a', 'b'], () => void hits++);
    Telemetry.execute(['a', 'b']);
    Telemetry.execute(['a', 'c']); // different event — no fire
    Telemetry.execute(['a']); // prefix — not an exact match, no fire
    Telemetry.detach('t2');
    assert.equal(hits, 1, 'exact-match only');
  });

  test('attachMany fires one handler across several events; detach clears all', (assert) => {
    const seen: string[] = [];
    Telemetry.attachMany(
      't3',
      [
        ['x', 'start'],
        ['x', 'stop'],
      ],
      (e) => void seen.push(e.at(-1)!),
    );
    Telemetry.execute(['x', 'start']);
    Telemetry.execute(['x', 'stop']);
    Telemetry.detach('t3');
    Telemetry.execute(['x', 'start']); // detached — no fire
    assert.deepEqual(seen, ['start', 'stop']);
  });

  test('a duplicate handler id throws', (assert) => {
    Telemetry.attach('dup', ['e'], () => {});
    assert.throws(() => Telemetry.attach('dup', ['e'], () => {}), /already exists/);
    Telemetry.detach('dup');
  });

  test('a throwing handler is auto-detached and the others still run', (assert) => {
    let good = 0;
    Telemetry.attach('bad', ['z'], () => {
      throw new Error('boom');
    });
    Telemetry.attach('good', ['z'], () => void good++);
    Telemetry.execute(['z']); // bad throws → detached; good still runs
    assert.deepEqual(Telemetry.listHandlers(['z']), ['good'], 'the buggy handler was removed');
    Telemetry.execute(['z']); // only good now
    assert.equal(good, 2, 'the emitter kept working across a handler fault');
    Telemetry.detach('good');
  });

  test('span brackets an operation with start then stop and a measured duration', async (assert) => {
    const events: string[] = [];
    let stopDuration = -1;
    Telemetry.attachMany(
      's1',
      [
        ['work', 'start'],
        ['work', 'stop'],
      ],
      (e, m) => {
        events.push(e.at(-1)!);
        if (e.at(-1) === 'stop') stopDuration = m.duration;
      },
    );
    const out = await Telemetry.span(['work'], { job: 1 }, () => ({ result: 6 * 7 }));
    Telemetry.detach('s1');

    assert.equal(out, 42, 'span returns the operation result');
    assert.deepEqual(events, ['start', 'stop'], 'start then stop, in order');
    assert.true(stopDuration >= 0, 'stop carried a measured duration');
  });

  test('span emits exception and re-raises when the operation throws', async (assert) => {
    const events: string[] = [];
    Telemetry.attachMany(
      's2',
      [
        ['risky', 'start'],
        ['risky', 'stop'],
        ['risky', 'exception'],
      ],
      (e) => void events.push(e.at(-1)!),
    );
    let raised = false;
    try {
      await Telemetry.span(['risky'], {}, () => {
        throw new Error('nope');
      });
    } catch {
      raised = true;
    }
    Telemetry.detach('s2');

    assert.true(raised, 'the error propagates to the caller');
    assert.deepEqual(events, ['start', 'exception'], 'exception, not stop');
  });
});
