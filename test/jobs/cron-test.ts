import { module, test } from 'qunitx';
import { memoryStore } from '../../lib/node/index.ts';
import { jobQueue, cronMatch } from '../../lib/jobs/index.ts';

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

module('Jobs | cron scheduling', { concurrency: true }, () => {
  test('cronMatch handles stars, numbers, ranges, lists, and steps (UTC)', (assert) => {
    const at = (iso: string) => new Date(iso);
    assert.true(cronMatch('30 9 * * *', at('2020-01-02T09:30:00Z')), 'exact minute + hour');
    assert.false(cronMatch('30 9 * * *', at('2020-01-02T09:31:00Z')), 'wrong minute');
    assert.true(
      cronMatch(['*' + '/15', '*', '*', '*', '*'].join(' '), at('2020-01-02T10:45:00Z')),
      'every 15m',
    );
    assert.false(
      cronMatch(['*' + '/15', '*', '*', '*', '*'].join(' '), at('2020-01-02T10:46:00Z')),
      'off the step',
    );
    assert.true(cronMatch('0 0 * * 1-5', at('2020-01-06T00:00:00Z')), 'weekday range (a Monday)');
    assert.false(cronMatch('0 0 * * 1-5', at('2020-01-04T00:00:00Z')), 'a Saturday is excluded');
    assert.true(cronMatch('0 9,17 * * *', at('2020-01-02T17:00:00Z')), 'a list of hours');
  });

  test('a schedule enqueues its job each matching minute — and only once per minute', async (assert) => {
    const clock = { t: Date.UTC(2020, 0, 1, 9, 30, 0) }; // 09:30:00 UTC — matches '30 9 * * *'
    let runs = 0;
    const jobs = jobQueue({
      store: memoryStore(),
      workers: { 'reports.daily': () => void runs++ },
      cron: { '30 9 * * *': { worker: 'reports.daily' } },
      now: () => clock.t,
      pollMs: 10,
    });

    await settle(60); // several ticks within the 09:30 minute
    assert.equal(runs, 1, 'fired once at 09:30 despite many ticks in that minute');

    clock.t = Date.UTC(2020, 0, 1, 9, 31, 0); // 09:31 — no longer matches
    await settle(40);
    assert.equal(runs, 1, 'did not fire off-schedule');

    clock.t = Date.UTC(2020, 0, 2, 9, 30, 0); // next day, 09:30 again
    await settle(60);
    assert.equal(runs, 2, 'fired again the next day at 09:30');
    jobs.stop();
  });

  test('cron enqueues onto its configured queue at its priority', async (assert) => {
    const clock = { t: Date.UTC(2020, 0, 1, 0, 0, 0) };
    const seen: string[] = [];
    const jobs = jobQueue({
      store: memoryStore(),
      queues: { critical: 5, default: 5 },
      workers: { beat: (_a, job) => void seen.push(job.queue) },
      cron: { '* * * * *': { worker: 'beat', queue: 'critical' } }, // every minute
      now: () => clock.t,
      pollMs: 10,
    });
    await settle(50);
    assert.deepEqual(seen, ['critical'], 'the cron job ran on its configured queue');
    jobs.stop();
  });

  test('cron passes its entry.args as the worker’s first argument, defaulting to {}', async (assert) => {
    // The worker is `(args, job)`; for a cron run the args come from the entry (`entry.args ?? {}`).
    const clock = { t: Date.UTC(2020, 0, 1, 0, 0, 0) }; // 00:00 — matches '0 * * * *' only
    const seen: unknown[] = [];
    const jobs = jobQueue({
      store: memoryStore(),
      workers: {
        withArgs: (args) => void seen.push(args),
        noArgs: (args) => void seen.push(args),
      },
      cron: {
        '0 * * * *': { worker: 'withArgs', args: { report: 'daily' } }, // top of the hour, with args
        '30 * * * *': { worker: 'noArgs' }, // half past, no args configured
      },
      now: () => clock.t,
      pollMs: 10,
    });

    await settle(50);
    assert.deepEqual(
      seen,
      [{ report: 'daily' }],
      'the worker received the entry’s configured args',
    );

    clock.t = Date.UTC(2020, 0, 1, 0, 30, 0); // 00:30 — matches '30 * * * *' only
    await settle(50);
    assert.deepEqual(
      seen,
      [{ report: 'daily' }, {}],
      'a schedule with no args defaults the first argument to {}',
    );
    jobs.stop();
  });

  test('one expression can drive several workers via a list value', async (assert) => {
    // Oban's crontab allows duplicate rows; a record key can't repeat, so a LIST value is the
    // JS-shaped equivalent — every entry under the expression enqueues on each matching minute.
    const clock = { t: Date.UTC(2020, 0, 1, 9, 0, 0) }; // 09:00 — matches '0 9 * * *'
    const seen: string[] = [];
    const jobs = jobQueue({
      store: memoryStore(),
      queues: { default: 5, analytics: 5 },
      workers: {
        'reports.daily': (_a, job) => void seen.push(`daily:${job.queue}`),
        'metrics.snapshot': (_a, job) => void seen.push(`metrics:${job.queue}`),
      },
      cron: {
        '0 9 * * *': [
          { worker: 'reports.daily' }, // default queue
          { worker: 'metrics.snapshot', queue: 'analytics' }, // its own queue/priority
        ],
      },
      now: () => clock.t,
      pollMs: 10,
    });

    await settle(60); // several ticks within the 09:00 minute
    assert.deepEqual(
      [...seen].sort(),
      ['daily:default', 'metrics:analytics'],
      'both listed workers fired once on the shared schedule, each on its own queue',
    );
    jobs.stop();
  });

  test('distinct expressions matching the same minute each fire independently', async (assert) => {
    const clock = { t: Date.UTC(2020, 0, 1, 9, 30, 0) }; // 09:30 matches BOTH schedules below
    const seen: string[] = [];
    const jobs = jobQueue({
      store: memoryStore(),
      workers: {
        'reports.daily': () => void seen.push('daily'),
        heartbeat: () => void seen.push('heartbeat'),
      },
      cron: {
        '30 9 * * *': { worker: 'reports.daily' }, // 09:30 daily
        '* * * * *': { worker: 'heartbeat' }, // every minute — also matches 09:30
      },
      now: () => clock.t,
      pollMs: 10,
    });

    await settle(60); // several ticks within the 09:30 minute
    assert.deepEqual(
      [...seen].sort(),
      ['daily', 'heartbeat'],
      'both schedules fired at 09:30 — exactly one job per schedule, no cross-blocking',
    );
    jobs.stop();
  });
});
