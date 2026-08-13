import { module, test } from 'qunitx';
import { producer, consumer, producerConsumer, tick } from '../../lib/stage/index.ts';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const settle = async (turns = 100) => {
  for (let i = 0; i < turns; i++) await tick();
};

module('Stage | GenStage', { concurrency: true }, () => {
  test('a slow consumer throttles a fast producer — demand bounded, rest buffers', async (assert) => {
    const src = producer<number>();
    const handled: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const sink = consumer<number>({
      max: 5,
      handleEvents: async (batch) => {
        inFlight += batch.length;
        peak = Math.max(peak, inFlight);
        await tick(); // simulate async work — this latency IS the backpressure
        handled.push(...batch);
        inFlight -= batch.length;
      },
    });
    sink.subscribe(src);
    await tick();

    src.push(...range(20));
    await tick();
    assert.true(src.buffered > 0, 'events beyond current demand are buffered, not delivered');

    await settle();
    assert.deepEqual(handled, range(20), 'all 20 eventually delivered, in order');
    assert.equal(src.buffered, 0, 'the buffer fully drained');
    assert.true(peak <= 5, `never more than max=5 outstanding at once (peak ${peak})`);
    src.stop();
  });

  test('demand dispatcher fans out — two consumers share the work', async (assert) => {
    const src = producer<number>();
    const a: number[] = [];
    const b: number[] = [];
    consumer<number>({ max: 1, handleEvents: (batch) => void a.push(...batch) }).subscribe(src);
    consumer<number>({ max: 1, handleEvents: (batch) => void b.push(...batch) }).subscribe(src);
    await tick();

    src.push(...range(6));
    await settle();

    assert.deepEqual(
      [...a, ...b].sort((x, y) => x - y),
      range(6),
      'every event delivered exactly once',
    );
    assert.true(a.length > 0 && b.length > 0, 'both consumers got work (fan-out)');
    assert.equal(a.length + b.length, 6, 'no duplication across consumers');
    src.stop();
  });

  test('broadcast dispatcher — every consumer gets every event, paced to the slowest', async (assert) => {
    const src = producer<number>({ dispatcher: 'broadcast' });
    const a: number[] = [];
    const b: number[] = [];
    consumer<number>({ max: 10, handleEvents: (batch) => void a.push(...batch) }).subscribe(src);
    consumer<number>({ max: 10, handleEvents: (batch) => void b.push(...batch) }).subscribe(src);
    await tick();

    src.push(...range(3));
    await settle();

    assert.deepEqual(a, range(3), 'consumer A saw all events');
    assert.deepEqual(b, range(3), 'consumer B saw all events');
    src.stop();
  });

  test('broadcast paces to the slowest — a consumer with no demand holds everyone back', async (assert) => {
    const src = producer<number>({ dispatcher: 'broadcast' });
    const fast: number[] = [];
    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((r) => (releaseSlow = r));

    consumer<number>({ max: 10, handleEvents: (b) => void fast.push(...b) }).subscribe(src);
    consumer<number>({
      max: 1, // only ever asks for 1 until its handler resolves
      handleEvents: async (b) => {
        void b;
        await slowGate; // never re-asks until released
      },
    }).subscribe(src);
    await tick();

    src.push(...range(5));
    await settle();
    // Broadcast can only send min-demand across subs; the slow consumer caps everyone at 1.
    assert.deepEqual(fast, [0], 'the fast consumer is held to what the slow one can take');
    assert.true(
      src.buffered > 0,
      'the rest waits in the buffer until the slow consumer catches up',
    );

    releaseSlow();
    await settle();
    assert.deepEqual(fast, range(5), 'once the slow consumer drains, the rest flow');
    src.stop();
  });

  test('producer_consumer chains — transform is backpressured end to end', async (assert) => {
    const src = producer<number>();
    const doubler = producerConsumer<number, number>({
      handleEvents: (batch) => batch.map((n) => n * 2),
    });
    const out: number[] = [];
    doubler.subscribe(src);
    consumer<number>({ handleEvents: (batch) => void out.push(...batch) }).subscribe(doubler);
    await tick();

    src.push(...range(4));
    await settle();
    assert.deepEqual(out, [0, 2, 4, 6], 'each event flowed through the transform, in order');
    src.stop();
  });

  test('a pull producer generates EXACTLY the demand — never races ahead', async (assert) => {
    let generated = 0;
    const src = producer<number>({
      handleDemand: (n) => {
        const events = Array.from({ length: n }, () => generated++);
        return events;
      },
    });
    const seen: number[] = [];
    consumer<number>({ max: 3, handleEvents: (batch) => void seen.push(...batch) }).subscribe(src);
    await tick();

    // With max=3 and a min=0 refill, it pulls 3, hands them over, then pulls the next 3…
    await settle(5);
    assert.true(
      generated <= seen.length + 3,
      'the source never gets more than one window ahead of the sink',
    );
    assert.deepEqual(seen.slice(0, 3), [0, 1, 2], 'first window pulled in order');
    src.stop();
  });

  test('events pushed before any subscriber buffer until demand arrives', async (assert) => {
    const src = producer<number>();
    src.push(...range(3)); // no consumers yet
    assert.equal(src.buffered, 3, 'nothing is lost with no demand');

    const seen: number[] = [];
    consumer<number>({ handleEvents: (batch) => void seen.push(...batch) }).subscribe(src);
    await settle();
    assert.deepEqual(seen, range(3), 'a late subscriber drains the backlog');
    assert.equal(src.buffered, 0, 'buffer emptied');
    src.stop();
  });
});
