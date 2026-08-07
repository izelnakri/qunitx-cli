import { module, test } from 'qunitx';
import { openFeed, eventReporter, FEED_CAPACITY } from '../../lib/api/events.ts';
import type { Config } from '../../lib/types.ts';
import '../helpers/custom-asserts.ts';

// No browser here. The queue mechanics these used to cover — late consumer, flood, close with
// values still buffered — now belong to `Stream.channel` and are pinned in test/stream/. What is
// left is this module's own contribution: the projection from reporter callbacks to RunEvents,
// and the feed's configuration.

const CONFIG = {} as Config;

module('API | events | eventReporter', { concurrency: true }, () => {
  test('projects each reporter callback into one ordered feed', async (assert) => {
    const channel = openFeed();
    const reporter = eventReporter(channel);

    reporter.onRunStart?.(CONFIG, { fileCount: 2, groupCount: 1 });
    reporter.onTestEnd?.(CONFIG, { status: 'passed', fullName: ['Cart', 'adds'], runtime: 3 });
    reporter.onNotice?.(CONFIG, { level: 'info', message: 'scoped to 2 files' });
    reporter.onBrowserLog?.(CONFIG, { type: 'error', text: 'boom', args: [] });
    channel.close();

    const seen = (await Array.fromAsync(channel.stream)).map((event) => event.kind);

    assert.deepEqual(seen, ['runStart', 'test', 'notice', 'browserLog'], 'in emission order');
  });

  test('test events carry the same projection the result does', async (assert) => {
    const channel = openFeed();
    const reporter = eventReporter(channel);

    reporter.onTestEnd?.(CONFIG, { status: 'failed', fullName: ['Cart', 'empties'], runtime: 1 });
    channel.close();

    const [event] = await Array.fromAsync(channel.stream);

    assert.equal(
      event.kind === 'test' && event.test.fullName,
      'Cart: empties',
      'the display name, not the raw array',
    );
  });
});

module('API | events | openFeed', { concurrency: true }, () => {
  test('is a Stream.channel configured for a test run', async (assert) => {
    const feed = openFeed();
    feed.emit({ kind: 'notice', notice: { level: 'info', message: 'hello' } });

    assert.strictEqual(feed.buffered, 1, 'buffers for a consumer that has not arrived');
    feed.close();
    assert.deepEqual(
      (await feed.stream.collect()).map((e) => e.kind),
      ['notice'],
      'and its stream is an ordinary Stream — combinators included',
    );
  });

  test('drops the OLDEST past the cap, so the newest survive a flood', (assert) => {
    const feed = openFeed();
    for (let index = 0; index < FEED_CAPACITY + 5; index++) {
      feed.emit({ kind: 'browserLog', log: { type: 'log', text: String(index), args: [] } });
    }

    assert.strictEqual(feed.buffered, FEED_CAPACITY, 'held at the cap');
    assert.strictEqual(feed.dropped, 5, 'and says how many it lost');
  });

  test('onDemand fires when a consumer attaches — the lazy-start hook', async (assert) => {
    let started = 0;
    const feed = openFeed({ onDemand: () => void (started += 1) });
    const collected = feed.stream.collect();

    assert.strictEqual(started, 0, 'building the feed started nothing');
    feed.close();
    await collected;
    assert.strictEqual(started, 1, 'the consumer is what started it');
  });
});

module('API | events | drops are observable', { concurrency: true }, () => {
  test('a capped feed reports what it lost, so a gap is never silent', (assert) => {
    const feed = openFeed();
    for (let index = 0; index < FEED_CAPACITY + 3; index++) {
      feed.emit({ kind: 'browserLog', log: { type: 'log', text: String(index), args: [] } });
    }

    assert.strictEqual(feed.dropped, 3, 'the count is the signal');
    assert.strictEqual(feed.buffered, FEED_CAPACITY, 'and memory stays bounded');
  });

  test('an ordinary run drops nothing at all', (assert) => {
    const feed = openFeed();
    for (let index = 0; index < 500; index++) {
      feed.emit({ kind: 'test', test: { name: `t${index}` } as never });
    }

    assert.strictEqual(feed.dropped, 0, 'the cap is far above any real suite');
  });
});
