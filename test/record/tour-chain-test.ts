import { module, test } from 'qunitx';
import { StepQueue, STEP_NAMES } from '../../lib/record/tour/chain.ts';
import type { TourSteps, TourTab } from '../../lib/record/tour/index.ts';
import type { Page } from 'playwright-core';

// A run that does nothing but write down each step it is asked to take, in the order it takes
// them. A step that starts writes `name…`; one that ends, `…name`, so overlapping steps show.
function standIn(options: { slowMs?: Partial<Record<string, number>>; failing?: string } = {}) {
  const log: string[] = [];
  const attempts: Record<string, number> = {};
  const tab = { page: {} as Page } satisfies TourTab;
  const step =
    (name: string, value?: unknown) =>
    async (...args: unknown[]) => {
      const label = args.length
        ? `${name}(${args.map((arg) => JSON.stringify(arg)).join(', ')})`
        : name;
      attempts[name] = (attempts[name] ?? 0) + 1;
      log.push(`${label}…`);
      await new Promise((done) => setTimeout(done, options.slowMs?.[name] ?? 0));
      if (options.failing === name && attempts[name] < 3) throw new Error(`${name} broke`);
      log.push(`…${label}`);
      return value;
    };
  const steps = Object.fromEntries(
    STEP_NAMES.map((name) => [name, step(name, name === 'open' ? tab : undefined)]),
  ) as unknown as TourSteps;
  const run = Object.assign(steps, { page: tab.page, tabs: [tab] });
  const queue = new StepQueue(run);
  return { tour: queue.tour(run), queue, log, attempts, tab };
}

module('Record | tour chains', { concurrency: true }, () => {
  test('one await runs a chain in order, each step after the one before is done', async (assert) => {
    const { tour, log } = standIn({ slowMs: { goto: 20 } });

    await tour.goto('/').click('#buy').caption('Paid');

    assert.deepEqual(log, [
      'goto("/")…',
      '…goto("/")',
      'click("#buy")…',
      '…click("#buy")',
      'caption("Paid")…',
      '…caption("Paid")',
    ]);
  });

  test('a chain resolves to its last step’s value, as `open` resolves to its tab', async (assert) => {
    const { tour, tab } = standIn();

    assert.strictEqual(await tour.wait(10).open('/help'), tab);
    assert.strictEqual(
      await tour.open('/help').wait(10),
      undefined,
      'and a step after it, to its own',
    );
  });

  test('awaiting each step is the same as it always was', async (assert) => {
    const { tour, log } = standIn();

    await tour.goto('/');
    await tour.caption('Hi');

    assert.deepEqual(log, ['goto("/")…', '…goto("/")', 'caption("Hi")…', '…caption("Hi")']);
  });

  test('two chains awaited together take turns on the page, never overlapping', async (assert) => {
    const { tour, log } = standIn({ slowMs: { goto: 30 } });

    await Promise.all([tour.goto('/a').caption('A'), tour.goto('/b').caption('B')]);

    for (let index = 0; index < log.length; index += 2) {
      assert.true(log[index].endsWith('…'), `${log[index]} starts`);
      assert.equal(
        log[index + 1],
        `…${log[index].slice(0, -1)}`,
        'and ends before the next starts',
      );
    }
    assert.true(log.indexOf('…goto("/a")') < log.indexOf('caption("A")…'));
    assert.true(log.indexOf('…goto("/b")') < log.indexOf('caption("B")…'));
  });

  test('a failed step fails its chain, and the steps chained after it never run', async (assert) => {
    const { tour, log } = standIn({ failing: 'click' });

    await assert.rejects(tour.goto('/').click('#gone').caption('Never'), /click broke/);

    assert.notOk(
      log.some((entry) => entry.startsWith('caption')),
      'the caption never ran',
    );
    await tour.caption('Recovered');
    assert.equal(
      log.at(-1),
      '…caption("Recovered")',
      'and a new chain runs as ever, as after a caught throw',
    );
  });

  test('a step is a Task: retry runs that step again, and only that step', async (assert) => {
    const { tour, attempts } = standIn({ failing: 'click' });

    await tour.goto('/').click('#flaky').retry(2);

    assert.deepEqual([attempts.goto, attempts.click], [1, 3], 'goto once, click until it held');
  });

  test('a step nobody awaited never runs, and the tour says which', async (assert) => {
    const { tour, queue, log } = standIn();

    await tour.goto('/');
    tour.caption('Forgotten');

    assert.throws(
      () => queue.checkEveryStepRan(),
      /tour\.caption\(\) was called but never awaited, so it never ran/,
    );
    assert.notOk(log.some((entry) => entry.startsWith('caption')));
  });

  test('every step chained before an awaited one counts as run', (assert) => {
    const { tour, queue } = standIn();
    const chain = tour.goto('/').caption('A');

    assert.throws(() => queue.checkEveryStepRan(), /tour\.goto\(\)/, 'not yet');
    return chain.then(() => {
      queue.checkEveryStepRan();
      assert.ok(true, 'and now nothing is left over');
    });
  });
});
