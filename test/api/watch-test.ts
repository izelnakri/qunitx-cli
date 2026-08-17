import { module, test } from 'qunitx';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withWatch } from './helpers.ts';
import { outputDir } from '../helpers/temp-dir.ts';
import { acquireBrowser } from '../helpers/browser-semaphore-queue.ts';
import { spawnCapture } from '../helpers/shell.ts';
import '../helpers/custom-asserts.ts';

const PASSING = 'test/fixtures/passing-tests.ts';
const FAILING = 'test/fixtures/failing-tests.ts';

// Enough for a cold start plus a browser launch on CI, and short enough that a leak fails the test
// well before the harness kills the whole worker with nothing to show for it.
const WATCH_EXIT_TIMEOUT_MS = 60_000;

const GREEN_TEST = `import { module, test } from 'qunitx';
module('Watched', () => {
  test('is green', (assert) => assert.true(true));
});
`;
const RED_TEST = `import { module, test } from 'qunitx';
module('Watched', () => {
  test('is red', (assert) => assert.true(false));
});
`;

module('API | watch | session', { concurrency: true }, () => {
  test('resolves once the first run has finished, with its result in hand', async (assert) => {
    await withWatch({ inputs: [PASSING] }, (session) => {
      assert.true(session.initial.ok);
      assert.equal(session.initial.counts.total, 3);
      assert.includes(session.url, 'http://localhost:');
    });
  });

  test('run() resolves with that run, not the previous one', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      const again = await session.run();

      assert.true(again.ok);
      assert.equal(again.counts.total, 3, 'a full result, not an empty snapshot');
      assert.notEqual(again, session.initial, 'a distinct result object per run');
    });
  });

  test('iteration yields the initial run first, then each rerun', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      const seen: number[] = [];
      const consume = (async () => {
        for await (const result of session) {
          seen.push(result.counts.total);
          if (seen.length === 2) break;
        }
      })();

      await session.run();
      await consume;

      assert.deepEqual(seen, [3, 3], 'the initial run and the rerun both arrive');
    });
  });

  test('close() is idempotent and ends the iteration', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      await session.close();
      await session.close();

      const seen: number[] = [];
      for await (const result of session) seen.push(result.counts.total);

      assert.deepEqual(seen, [3], 'the queued initial result still drains, then it ends');
    });
  });

  // The one thing `withWatch` cannot check: this suite's own process stays alive by design, so a
  // handle surviving close() is invisible from inside it. It shipped that way — close() released
  // the browser, the server and the watchers but not esbuild's incremental context, whose REF'd
  // service child then kept every API consumer's script running forever after the await returned.
  test('close() releases esbuild too, so a script that closes can exit', async (assert) => {
    await using output = outputDir('api-watch-exit');
    const permit = await acquireBrowser();
    try {
      const { stdout } = await spawnCapture(
        `node test/fixtures/watch-close-exits.ts ${PASSING} ${output.path}`,
        // spawnCapture does not inherit the environment, and without it the child has no PATH to
        // find Chrome with — it falls back to playwright's own download and dies on a missing one.
        { timeout: WATCH_EXIT_TIMEOUT_MS, env: { ...process.env, FORCE_COLOR: '0' } },
      );
      const handles = JSON.parse(stdout) as string[];

      assert.deepEqual(
        handles.filter((handle) => handle === 'ProcessWrap'),
        [],
        `no child process outlives close(), got ${stdout.trim()}`,
      );
    } finally {
      permit.release();
    }
  });
});

module('API | watch | verbs', { concurrency: true }, () => {
  test('latest tracks the most recent run without consuming the iteration', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      assert.equal(session.latest, session.initial, 'it starts at the initial run');

      const again = await session.run();

      assert.equal(session.latest, again, 'and follows each rerun');

      const seen: number[] = [];
      for await (const result of session) {
        seen.push(result.counts.total);
        if (seen.length === 2) break;
      }

      assert.deepEqual(seen, [3, 3], 'reading latest did not steal either result');
    });
  });

  test('running says whether a run is in flight', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      assert.false(session.running, 'idle once the initial run has finished');

      const inFlight = session.run();
      assert.true(session.running, 'true while a rerun is happening');

      await inFlight;
      assert.false(session.running, 'and false again once it settles');
    });
  });

  test('runAll() runs the whole suite and clears the session selectors', async (assert) => {
    // Line 4 is the first `test(...)` — line 3 is the `module(...)` wrapper, which selects all
    // three. Scoped to one test, so a plain rerun stays pinned to it and only runAll unpins.
    await withWatch({ inputs: [`${PASSING}#4`] }, async (session) => {
      assert.equal(session.initial.counts.total, 1, 'the line target scoped the initial run');

      const all = await session.runAll();

      assert.equal(all.counts.total, 3, 'runAll dropped the line target');
      assert.equal(session.latest, all);
    });
  });

  test('runFailed() re-runs only the files that failed', async (assert) => {
    await withWatch({ inputs: [PASSING, FAILING] }, async (session) => {
      assert.false(session.initial.ok, 'the pair starts red');

      const failed = await session.runFailed();

      assert.true(
        failed.files.every((file) => file.endsWith('failing-tests.ts')),
        'the rerun is scoped to the failing file alone',
      );
    });
  });

  test('runFailed() with nothing failing repeats the last run and says so', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      assert.true(session.initial.ok, 'nothing has failed');

      const repeated = await session.runFailed();

      assert.equal(repeated.counts.total, 3, 'it repeated the last run');
      assert.true(
        repeated.notices.some((notice) =>
          notice.message.includes('No tests failed in the last run'),
        ),
        'and reported the fallback rather than silently doing something else',
      );
    });
  });

  test('abort() while idle is a no-op that publishes no result', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      await session.abort();

      assert.equal(session.latest, session.initial, 'no phantom result was manufactured');
      assert.false(session.running);
    });
  });
});

module('API | watch | events', { concurrency: true }, () => {
  test('events() is flat across reruns and ends each with runEnd', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      const kinds: string[] = [];
      const consume = (async () => {
        for await (const event of session.events()) {
          kinds.push(event.kind);
          if (kinds.filter((kind) => kind === 'runEnd').length === 2) break;
        }
      })();

      await session.run();
      await session.run();
      await consume;

      assert.equal(kinds.filter((kind) => kind === 'runEnd').length, 2, 'one end per rerun');
      assert.equal(
        kinds.filter((kind) => kind === 'runStart').length,
        2,
        'and one start per rerun',
      );
      assert.true(kinds.filter((kind) => kind === 'test').length >= 6, 'with every test between');
    });
  });

  test('events() returns the same feed on every call', async (assert) => {
    await withWatch({ inputs: [PASSING] }, (session) => {
      assert.equal(session.events(), session.events(), 'a second call must not double the events');
    });
  });
});

module('API | watch | reruns', { concurrency: true }, () => {
  test('a save produces a fresh result on the iterator', async (assert) => {
    // The whole feature, end to end: a file inside the watched tree changes on disk, the watcher
    // notices, the bundle is rebuilt, and the new result arrives on the session's iteration.
    await using project = outputDir('api-watch-project');
    const testFile = path.join(project.path, 'sample-test.ts');
    await fs.mkdir(project.path, { recursive: true });
    await fs.writeFile(testFile, GREEN_TEST);

    await withWatch({ inputs: [testFile] }, async (session) => {
      assert.equal(session.initial.counts.total, 1, 'the fixture registers one test');
      assert.true(session.initial.ok, 'and starts green');

      const iterator = session[Symbol.asyncIterator]();
      await iterator.next(); // the initial run, already queued
      const afterSave = iterator.next();

      await fs.writeFile(testFile, RED_TEST);
      const { value } = await afterSave;

      assert.false(value.ok, 'the rerun ran the edited file');
      assert.equal(value.counts.failed, 1);
      assert.true(session.initial.ok, 'and the initial result is not retroactively changed');
    });
  });

  test('run() picks up an edit rather than replaying the cached bundle', async (assert) => {
    await using project = outputDir('api-watch-manual');
    const testFile = path.join(project.path, 'sample-test.ts');
    await fs.mkdir(project.path, { recursive: true });
    await fs.writeFile(testFile, GREEN_TEST);

    await withWatch({ inputs: [testFile] }, async (session) => {
      assert.true(session.initial.ok);

      await fs.writeFile(testFile, RED_TEST);
      const afterEdit = await session.run();

      assert.false(afterEdit.ok, 'an explicit rerun rebuilds too');
      assert.equal(afterEdit.counts.failed, 1);
    });
  });
});

module('API | watch | results() as a Stream', { concurrency: true }, () => {
  test('the coarse feed carries combinators', async (assert) => {
    await withWatch({ inputs: [FAILING] }, async (session) => {
      const [red] = await session
        .results()
        .filter((r) => !r.ok)
        .take(1)
        .collect();

      assert.false(red.ok);
      assert.true(red.failures.length > 0, 'notify-on-first-red, in one expression');
    });
  });

  test('events() is a Stream too, flat across reruns', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      const ends = session
        .events()
        .filter((e) => e.kind === 'runEnd')
        .take(2)
        .collect();
      await session.run();
      await session.run();

      assert.strictEqual((await ends).length, 2, 'one runEnd per rerun');
    });
  });
});

// The five below are documented as outside semver, which is a promise about CHANGE, not about
// absence — while they exist they have to be the session's real machinery rather than a
// plausible-looking stand-in. Each assertion here checks identity with something only the live
// object could satisfy.
module('API | watch | live objects', { concurrency: true }, () => {
  test('browser, page and webServer are the session s real ones', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      assert.true(session.browser.isConnected(), 'a live playwright Browser');
      assert.true(
        session.page.url().startsWith(session.url),
        `the page is on the session's own URL, got ${session.page.url()}`,
      );
      assert.strictEqual(await session.page.evaluate(() => 1 + 1), 2, 'the page really evaluates');
      // The server is this project's HTTPServer, and routes registered on it are served.
      session.webServer.get('/live-object-probe', (_request, response) =>
        response.json({ ok: true }),
      );
      const probe = await fetch(`${session.url}/live-object-probe`);

      assert.deepEqual(await probe.json(), { ok: true }, 'a route added through it is served');
    });
  });

  test('esbuild is the incremental context, and rebuilding through it works', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      // Non-null here because the initial run has already built once — that is the whole reason
      // the property is typed nullable rather than asserted.
      assert.notStrictEqual(session.esbuild, null, 'a context exists after the first build');
      const rebuilt = await session.esbuild!.rebuild();

      assert.true(rebuilt.outputFiles!.length > 0, 'it is a usable BuildContext');
    });
  });

  test('fileWatchers is the live record, keyed by watched path', async (assert) => {
    await withWatch({ inputs: [PASSING] }, (session) => {
      const watched = Object.keys(session.fileWatchers);

      assert.true(watched.length > 0, `something is being watched, got ${JSON.stringify(watched)}`);
      assert.true(
        watched.some((key) => key.includes('fixtures')),
        `the watched paths cover the input, got ${JSON.stringify(watched)}`,
      );
      // Same object, not a copy — the getter must not snapshot.
      assert.strictEqual(session.fileWatchers, session.fileWatchers);

      return Promise.resolve();
    });
  });
});
