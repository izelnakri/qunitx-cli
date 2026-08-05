import { module, test } from 'qunitx';
import {
  Channel,
  MAX_BUFFERED_EVENTS,
  eventReporter,
  type RunEvent,
} from '../../lib/api/events.ts';
import type { Config } from '../../lib/types.ts';
import '../helpers/custom-asserts.ts';

// No browser here: the channel is the piece both sessions are built on, and its awkward cases —
// a consumer arriving late, a producer flooding, a close with values still buffered — are far
// easier to provoke directly than through a real run.

const CONFIG = {} as Config;

module('API | events | Channel', { concurrency: true }, () => {
  test('a late consumer still sees everything that was pushed', async (assert) => {
    const channel = new Channel<number>();
    channel.push(1);
    channel.push(2);
    channel.close();

    const seen: number[] = [];
    for await (const value of channel) seen.push(value);

    assert.deepEqual(seen, [1, 2], 'buffered until someone asked');
  });

  test('a waiting consumer is handed values as they arrive', async (assert) => {
    const channel = new Channel<string>();
    const iterator = channel[Symbol.asyncIterator]();
    const pending = iterator.next();

    assert.equal(channel.buffered, 0, 'nothing buffers while a consumer is parked');
    channel.push('a');

    assert.deepEqual(await pending, { done: false, value: 'a' });
  });

  test('close() drains the buffer before ending', async (assert) => {
    const channel = new Channel<number>();
    channel.push(1);
    channel.close();

    const iterator = channel[Symbol.asyncIterator]();

    assert.deepEqual(await iterator.next(), { done: false, value: 1 }, 'the queued value survives');
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  });

  test('close() wakes a consumer parked on a value that never comes', async (assert) => {
    const channel = new Channel<number>();
    const pending = channel[Symbol.asyncIterator]().next();
    channel.close();

    assert.deepEqual(await pending, { done: true, value: undefined }, 'released rather than hung');
  });

  test('pushing after close is ignored rather than thrown', (assert) => {
    const channel = new Channel<number>();
    channel.close();
    channel.push(1);

    assert.equal(channel.buffered, 0, 'a late event from a run being torn down is dropped');
  });

  test('close() is idempotent', (assert) => {
    const channel = new Channel<number>();
    channel.close();
    channel.close();

    assert.true(channel.closed);
  });

  test('a flood past the cap drops the oldest and counts what it dropped', async (assert) => {
    const channel = new Channel<number>();
    for (let index = 0; index < MAX_BUFFERED_EVENTS + 10; index++) channel.push(index);

    assert.equal(channel.buffered, MAX_BUFFERED_EVENTS, 'the buffer holds at the cap');
    assert.equal(channel.dropped, 10, 'and says how many it lost');

    const iterator = channel[Symbol.asyncIterator]();

    assert.deepEqual(
      await iterator.next(),
      { done: false, value: 10 },
      'the oldest went, the newest stayed — they are the ones next to whatever went wrong',
    );
  });

  test('an ordinary run drops nothing', (assert) => {
    const channel = new Channel<number>();
    for (let index = 0; index < 500; index++) channel.push(index);

    assert.equal(channel.dropped, 0, 'the cap is far above any real suite');
  });

  test('breaking out of the loop closes the channel', async (assert) => {
    const channel = new Channel<number>();
    channel.push(1);
    channel.push(2);

    for await (const _value of channel) break;

    assert.true(channel.closed);
  });
});

module('API | events | eventReporter', { concurrency: true }, () => {
  test('projects each reporter callback into one ordered feed', async (assert) => {
    const channel = new Channel<RunEvent>();
    const reporter = eventReporter(channel);

    reporter.onRunStart?.(CONFIG, { fileCount: 2, groupCount: 1 });
    reporter.onTestEnd?.(CONFIG, { status: 'passed', fullName: ['Cart', 'adds'], runtime: 3 });
    reporter.onNotice?.(CONFIG, { level: 'info', message: 'scoped to 2 files' });
    reporter.onBrowserLog?.(CONFIG, { type: 'error', text: 'boom', args: [] });
    channel.close();

    const seen = (await Array.fromAsync(channel)).map((event) => event.kind);

    assert.deepEqual(seen, ['runStart', 'test', 'notice', 'browserLog'], 'in emission order');
  });

  test('test events carry the same projection the result does', async (assert) => {
    const channel = new Channel<RunEvent>();
    const reporter = eventReporter(channel);

    reporter.onTestEnd?.(CONFIG, { status: 'failed', fullName: ['Cart', 'empties'], runtime: 1 });
    channel.close();

    const [event] = await Array.fromAsync(channel);

    assert.equal(
      event.kind === 'test' && event.test.fullName,
      'Cart: empties',
      'the display name, not the raw array',
    );
  });
});
