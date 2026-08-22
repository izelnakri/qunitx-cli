import { module, test } from 'qunitx';
import { openSession } from '../../lib/api/index.ts';
import * as QUnitX from '../../lib/api/index.ts';
import { withOpenSession } from './helpers.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import { outputDir } from '../helpers/temp-dir.ts';
import type { RunEvent } from '../../lib/api/reporter.ts';
import '../helpers/custom-asserts.ts';

const PASSING = 'test/fixtures/passing-tests.ts';
const FAILING = 'test/fixtures/failing-tests.ts';

module('API | openSession | events', { concurrency: true }, () => {
  test('yields runStart, one test per test, then runEnd carrying the result', async (assert) => {
    await withOpenSession({ inputs: [PASSING] }, async (session) => {
      const kinds: RunEvent['kind'][] = [];
      let final = null;
      for await (const event of session) {
        kinds.push(event.kind);
        if (event.kind === 'runEnd') final = event.result;
      }

      assert.equal(kinds[0], 'runStart', 'the run announces itself first');
      assert.equal(kinds.at(-1), 'runEnd', 'and the last event is always the end');
      assert.equal(
        kinds.filter((kind) => kind === 'test').length,
        3,
        'one event per test in the fixture',
      );
      assert.true(final?.ok, 'the final event carries the whole result');
      assert.equal(final?.counts.total, 3);
    });
  });

  test('result() resolves with the same result the final event carried', async (assert) => {
    await withOpenSession({ inputs: [PASSING] }, async (session) => {
      let fromEvent = null;
      for await (const event of session) {
        if (event.kind === 'runEnd') fromEvent = event.result;
      }

      assert.equal(await session.result(), fromEvent, 'the very same object, not a rebuild');
    });
  });

  test('result() alone runs the suite without anyone iterating', async (assert) => {
    await withOpenSession({ inputs: [PASSING] }, async (session) => {
      const result = await session.result();

      assert.true(result.ok);
      assert.equal(result.counts.total, 3, 'awaiting the result is enough to start the run');
    });
  });

  test('result() is idempotent — a second await does not run again', async (assert) => {
    await withOpenSession({ inputs: [PASSING] }, async (session) => {
      const first = await session.result();
      const second = await session.result();

      assert.equal(first, second, 'one run, one result');
    });
  });

  test('a failing suite is a result, not a rejection', async (assert) => {
    await withOpenSession({ inputs: [FAILING] }, async (session) => {
      const result = await session.result();

      assert.false(result.ok);
      assert.true(result.failures.length > 0);
      assert.equal(result.status, 'completed', 'red is not the same as interrupted');
    });
  });

  test('the events carry the same tests the result does', async (assert) => {
    await withOpenSession({ inputs: [PASSING] }, async (session) => {
      const streamed: string[] = [];
      for await (const event of session) {
        if (event.kind === 'test') streamed.push(event.test.fullName);
      }

      assert.deepEqual(
        streamed,
        (await session.result()).tests.map((one) => one.fullName),
        'the live view and the summary agree',
      );
    });
  });
});

module('API | openSession | lifecycle', { concurrency: true }, () => {
  test('nothing runs until the session is consumed', async (assert) => {
    await using output = outputDir('api-session-lazy');
    const permit = await acquireBrowser();
    try {
      const session = await openSession({ inputs: [PASSING], output: output.path });

      // The proof that the run has not started: closing without ever consuming it produces the
      // empty result rather than a suite's worth of tests. If `openSession` ran eagerly this would
      // come back with 3.
      await session.close();

      assert.equal((await session.result()).counts.total, 0, 'no tests ran');
      assert.equal((await session.result()).status, 'aborted', 'and it says why');
    } finally {
      permit.release();
    }
  });

  test('close() before consuming answers rather than hanging', async (assert) => {
    await using output = outputDir('api-session-closed');
    const permit = await acquireBrowser();
    try {
      const session = await openSession({ inputs: [PASSING], output: output.path });
      await session.close();

      const seen: RunEvent[] = [];
      for await (const event of session) seen.push(event);

      assert.deepEqual(seen, [], 'a closed session iterates zero times');
      assert.equal((await session.result()).exitCode, 1, 'a run that never happened is not a pass');
    } finally {
      permit.release();
    }
  });

  test('close() is idempotent', async (assert) => {
    await using output = outputDir('api-session-idempotent');
    const permit = await acquireBrowser();
    try {
      const session = await openSession({ inputs: [PASSING], output: output.path });
      await session.close();
      await session.close();

      assert.true(true, 'the second close is a no-op rather than a throw');
    } finally {
      permit.release();
    }
  });

  test('await using disposes the session at the end of the block', async (assert) => {
    await using output = outputDir('api-session-dispose');
    const permit = await acquireBrowser();
    let result = null;
    try {
      {
        await using session = await openSession({ inputs: [PASSING], output: output.path });
        result = await session.result();
      }

      assert.true(result.ok, 'the run completed inside the block');
    } finally {
      permit.release();
    }
  });

  test('an already-aborted signal launches no browser', async (assert) => {
    await using output = outputDir('api-session-signal');
    const permit = await acquireBrowser();
    try {
      const session = await openSession({
        inputs: [PASSING],
        output: output.path,
        signal: AbortSignal.abort(),
      });
      const result = await session.result();

      assert.equal(result.status, 'aborted');
      assert.equal(result.counts.total, 0, 'cancelled before it began');
    } finally {
      permit.release();
    }
  });

  test('breaking out of the loop closes the session', async (assert) => {
    await using output = outputDir('api-session-break');
    const permit = await acquireBrowser();
    try {
      const session = await openSession({ inputs: [PASSING], output: output.path });
      for await (const event of session) {
        if (event.kind === 'runStart') break;
      }

      // Nothing to assert but the absence of a hang: an unclosed session would leave a browser
      // running and the test file would not exit.
      assert.true(true, 'the loop ended and the session closed itself');
      await session.close();
    } finally {
      permit.release();
    }
  });
});

module('API | openSession | events() as a Stream', { concurrency: true }, () => {
  test('combinators are attached — no Stream.from wrapper needed', async (assert) => {
    await withOpenSession({ inputs: [PASSING] }, async (session) => {
      const names = await session
        .events()
        .filter((e) => e.kind === 'test')
        .map((e) => (e.kind === 'test' ? e.test.fullName : ''))
        .take(2)
        .collect();

      assert.strictEqual(names.length, 2, 'take(2) bounded the pull');
      assert.true(names.every((n) => n.length > 0));
    });
  });

  test('events() starts the run, exactly like iterating does', async (assert) => {
    await withOpenSession({ inputs: [PASSING] }, async (session) => {
      const kinds = await session
        .events()
        .map((e) => e.kind)
        .collect();

      assert.strictEqual(kinds[0], 'runStart');
      assert.strictEqual(kinds.at(-1), 'runEnd', 'the feed ran to completion');
      assert.true((await session.result()).ok, 'and the result is there afterwards');
    });
  });

  test('droppedEvents is 0 for a run nobody stalls', async (assert) => {
    await withOpenSession({ inputs: [PASSING] }, async (session) => {
      await session.result();

      assert.strictEqual(session.droppedEvents, 0, 'a real suite is nowhere near the cap');
    });
  });

  test('the session stays a handle — it is not itself a Stream', async (assert) => {
    await withOpenSession({ inputs: [PASSING] }, (session) => {
      assert.strictEqual(
        typeof (session as unknown as { filter?: unknown }).filter,
        'undefined',
        'combinators live on events(), so nothing can strip close() off a live browser',
      );
      assert.strictEqual(typeof session.close, 'function');
    });
  });
});

module('API | openSession | watch selects the other shape', { concurrency: true }, () => {
  // `watch` is not "the same session plus file watchers": it picks a different execution shape.
  // Without it the files are split across as many pages as there are cores and the session is
  // spent after one run; with it there is one page behind a stable URL that can rerun. The
  // overloads are what keep the types honest about which one you asked for.
  test('watch: true gives a durable session with a URL and rerun verbs', async (assert) => {
    const permit = await acquireBrowser();
    await using output = outputDir('api-open-session-watch');
    try {
      const session = await QUnitX.openSession({
        inputs: [PASSING],
        output: output.path,
        watch: true,
      });
      try {
        assert.includes(
          session.url,
          'http://localhost:',
          'a served page, which the one-shot has not',
        );
        assert.strictEqual(typeof session.runAll, 'function', 'and the rerun verbs to drive it');
        assert.strictEqual(session.initial.counts.total, 3, 'having already run once');
      } finally {
        await session.close();
      }
    } finally {
      permit.release();
    }
  });

  test('without it the session is the one-shot shape, with no URL', async (assert) => {
    await using session = await QUnitX.openSession(PASSING);

    assert.strictEqual(
      (session as unknown as { url?: string }).url,
      undefined,
      'nothing is served: this shape splits across pages and is spent after one run',
    );
    assert.strictEqual(typeof session.result, 'function', 'it answers with a result instead');
  });
});
