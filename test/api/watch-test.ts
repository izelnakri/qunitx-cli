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

// A restart is ONE transition in the life of a session, not a close followed by a new one. That
// distinction is the entire reason it exists, so most of these assert continuity rather than
// teardown: same object, same feeds, same iteration.
module('API | watch | restart', { concurrency: true }, () => {
  test('the session survives and its run reaches latest', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      const before = session.initial;
      const result = await session.restart();

      assert.strictEqual(result.counts.total, before.counts.total, 'it ran the suite again');
      assert.strictEqual(session.latest, result, 'latest follows the restart');
      assert.strictEqual(session.initial, before, 'initial still names the run it started with');
      assert.true(session.url.startsWith('http://localhost:'), 'it is serving again');
    });
  });

  test('results() and events() keep streaming straight across it', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      // Opened BEFORE the restart and read after. If the restart closed the channels, or let the
      // rebooted session get a different reporters array, neither of these would ever fill.
      const results = session.results().take(2).collect();
      const ends = session
        .events()
        .filter((event) => event.kind === 'runEnd')
        .take(2)
        .collect();

      await session.restart();
      await session.run();

      assert.strictEqual((await results).length, 2, 'results survived the restart');
      assert.strictEqual((await ends).length, 2, 'so did the event feed');
    });
  });

  test('a restart emits exactly one result, not two', async (assert) => {
    // It reboots into the SAME config, so the reporter shim that publishes runs survives and the
    // reboot's own initial run reaches it. Publishing again on top of that emitted two results
    // for one run — a consumer counting runs would have over-counted every restart.
    await withWatch({ inputs: [PASSING] }, async (session) => {
      // The feed opens with the buffered initial run, so three elements is exactly
      // [initial, restart, rerun]. The rerun on the end is what makes this a double-publish
      // detector: if the restart emitted twice, the third element would be its duplicate and
      // `latest` — by then the rerun — would not be it.
      const results = session.results().take(3).collect();

      await session.restart();
      await session.run();
      const [first, second, third] = await results;

      assert.strictEqual(first, session.initial, 'the feed opens with the initial run');
      assert.strictEqual(second.counts.total, first.counts.total, 'then the restart run');
      assert.strictEqual(third, session.latest, 'then the rerun — no duplicate in between');
    });
  });

  test('the live objects are replaced, not reused', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      const before = {
        browser: session.browser,
        page: session.page,
        server: session.webServer,
        esbuild: session.esbuild,
      };

      await session.restart();

      assert.notStrictEqual(session.browser, before.browser, 'a new browser');
      assert.notStrictEqual(session.page, before.page, 'a new page');
      assert.notStrictEqual(session.webServer, before.server, 'a new server');
      // The one that is deliberately NOT replaced. Disposing it would re-read nothing — a restart
      // reuses the same Config, so a fresh context would hold the very same plugin objects — and
      // the dispose-then-recreate respawns esbuild's service child for no gain.
      assert.strictEqual(session.esbuild, before.esbuild, 'the esbuild context is kept');
      assert.true(session.browser.isConnected(), 'and the new browser is live');
      assert.strictEqual(await session.page.evaluate(() => 2 + 2), 4, 'the new page evaluates');
    });
  });

  test('reruns and abort still work through the rebooted machinery', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      await session.restart();

      const rerun = await session.run();
      assert.true(rerun.counts.total > 0, 'the rebooted session reruns');
      assert.true(rerun.ok, 'and still passes');

      // The aborters are the reason this is here: each boot registers one and the set was never
      // pruned, so a restart that did not clear it would leave abort() publishing to the closed
      // server as well as the live one.
      await session.abort();
      assert.false(session.running, 'abort settles against the new server');
    });
  });

  test('two concurrent restarts are one restart', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      const [first, second] = await Promise.all([session.restart(), session.restart()]);

      assert.strictEqual(first, second, 'both callers get the same run');
      assert.true(session.browser.isConnected(), 'exactly one session survived');
    });
  });

  test('close() during a restart waits for it and leaves nothing running', async (assert) => {
    // The race the guard exists for: closing while the boot is half-built would race the teardown
    // against the thing being built, and leak whichever handles had already been created.
    await withWatch({ inputs: [PASSING] }, async (session) => {
      // Ordering is the assertion, because that is the guarantee: `close()` resolving means
      // everything is down. Without the wait it resolves as soon as the OLD session is closed,
      // while the restart is still booting a browser behind it.
      const order: string[] = [];
      const restarting = session.restart().then(
        () => order.push('restart'),
        () => order.push('restart'),
      );
      const closing = session.close().then(() => order.push('close'));
      await Promise.all([restarting, closing]);

      assert.deepEqual(order, ['restart', 'close'], 'close() waits for the restart to land');
      assert.false(session.browser.isConnected(), 'the browser the restart built is closed too');
    });
  });

  // Restart doubles every teardown path, which is exactly where a handle gets left behind — this
  // PR already found one where close() released everything except esbuild's incremental context,
  // and the symptom was a script that returned from close() and then hung forever.
  test('a restart-then-close cycle still lets the process exit', async (assert) => {
    await using output = outputDir('api-watch-restart-exit');
    const permit = await acquireBrowser();
    try {
      const { stdout } = await spawnCapture(
        `node test/fixtures/watch-restart-exits.ts ${PASSING} ${output.path}`,
        // spawnCapture does not inherit the environment, and without PATH the child cannot find
        // Chrome — it falls back to playwright's own download and dies on a missing one.
        { timeout: WATCH_EXIT_TIMEOUT_MS, env: { ...process.env, FORCE_COLOR: '0' } },
      );
      const handles = JSON.parse(stdout.trim().split('\n').at(-1)!) as string[];

      assert.deepEqual(
        handles.filter((handle) => handle === 'ProcessWrap'),
        [],
        `no child process outlives restart + close, got ${stdout.trim()}`,
      );
    } finally {
      permit.release();
    }
  });
});

module('API | watch | restart(patch)', { concurrency: true }, () => {
  // The bundle a session serves is fixed at `Config.setup`: `run(files)` narrows what EXECUTES
  // within it, but nothing widens what is in it. Reconfiguring is what a filter box or a scope
  // picker in a TUI needs, and it is the same operation either way — rebuild, reboot.
  test('a patch narrows the selection and the session keeps running', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      assert.equal(session.initial.counts.total, 3, 'the whole file to begin with');

      const narrowed = await session.restart({ filter: 'assert true works' });

      assert.equal(narrowed.counts.total, 1, 'the filter reached the rebuilt config');
      assert.includes(session.url, 'http://localhost:', 'and it is still a live session');
    });
  });

  test('a patch widens what is bundled, which no rerun verb can do', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      const widened = await session.restart({ inputs: [PASSING, FAILING] });

      assert.true(
        widened.counts.total > session.initial.counts.total,
        `expected more than ${session.initial.counts.total} tests, got ${widened.counts.total}`,
      );
    });
  });

  test('the feeds survive a patched restart', async (assert) => {
    // The failure this guards against is silent: both feeds are wired by pushing reporters onto
    // `config.state.reporters`, and a rebuilt config gets a fresh array. Skipping the re-attach
    // leaves results() and events() open and permanently empty — a session that looks alive.
    await withWatch({ inputs: [PASSING] }, async (session) => {
      const seen: number[] = [];
      const consume = (async () => {
        for await (const result of session.results()) {
          seen.push(result.counts.total);
          if (seen.length === 2) break;
        }
      })();

      await session.restart({ filter: 'assert true works' });
      await consume;

      assert.deepEqual(seen, [3, 1], 'the initial run, then the reconfigured one');
    });
  });

  test('a patch that cannot resolve leaves the session alive', async (assert) => {
    await withWatch({ inputs: [PASSING] }, async (session) => {
      const before = session.url;
      let rejected = false;
      try {
        await session.restart({ inputs: ['test/fixtures/there-is-no-such-directory/'] });
      } catch {
        rejected = true;
      }

      assert.true(rejected, 'an unresolvable patch is a rejection');
      // Resolved BEFORE the teardown precisely so this holds: a bad patch must not leave a
      // half-demolished session behind.
      assert.strictEqual(session.url, before, 'and the session it could not change still serves');
      assert.equal((await session.run()).counts.total, 3, 'and still runs');
    });
  });
});
