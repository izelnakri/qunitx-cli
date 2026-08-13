import { module, test } from 'qunitx';
import * as Server from '../../lib/commands/daemon/server.ts';
import * as Client from '../../lib/commands/daemon/client.ts';
import '../helpers/custom-asserts.ts';

// Regression coverage for the CI hang where a browser killed while the daemon was idle
// still reported isConnected()===true (the CDP transport hadn't processed the close yet),
// so a run proceeded against the dead handle and wedged in an unbounded newPage() until
// the 180s GROUP_TIMEOUT. Server.browserResponsive replaces that passive check with an active,
// bounded CDP round-trip. These stubs prove the property deterministically without a real
// Chrome: a stale isConnected + a CDP channel that never answers must resolve `false`
// WITHIN the budget — never hang.

type ProbeBrowser = Parameters<typeof Server.browserResponsive>[0];

module('Commands | Daemon | Server.browserResponsive', { concurrency: true }, () => {
  test('disconnected browser → false immediately, no CDP round-trip', async (assert) => {
    let probed = false;
    const browser = {
      isConnected: () => false,
      newBrowserCDPSession: () => {
        probed = true;
        return Promise.resolve({ detach: () => Promise.resolve() });
      },
    } as unknown as ProbeBrowser;

    assert.strictEqual(await Server.browserResponsive(browser, 'chromium'), false);
    assert.notOk(probed, 'skips the CDP probe once isConnected() is already false');
  });

  test('live browser (CDP answers) → true, and detaches the probe session', async (assert) => {
    let detached = false;
    const browser = {
      isConnected: () => true,
      newBrowserCDPSession: () =>
        Promise.resolve({
          detach: () => {
            detached = true;
            return Promise.resolve();
          },
        }),
    } as unknown as ProbeBrowser;

    assert.strictEqual(await Server.browserResponsive(browser, 'chromium'), true);
    // detach is fire-and-forget inside Server.browserResponsive; let its microtask flush.
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(detached, 'healthy probe session is detached so it does not leak across runs');
  });

  test('stale isConnected + wedged CDP channel → false within budget (does NOT hang)', async (assert) => {
    let lateSession: { detach: () => Promise<void> } | null = null;
    let lateDetached = false;
    const browser = {
      isConnected: () => true, // stale: reports connected though Chrome is dead
      // Never resolves within the budget — mimics a CDP send to a doomed browser.
      newBrowserCDPSession: () =>
        new Promise((resolve) => {
          lateSession = {
            detach: () => {
              lateDetached = true;
              return Promise.resolve();
            },
          };
          // Resolve well after the probe's short timeout to exercise late-session cleanup.
          setTimeout(() => resolve(lateSession), 60);
        }),
    } as unknown as ProbeBrowser;

    const start = Date.now();
    const alive = await Server.browserResponsive(browser, 'chromium', 20);
    const elapsed = Date.now() - start;

    assert.strictEqual(alive, false, 'a wedged CDP channel is treated as dead');
    assert.ok(elapsed < 500, `resolved in ${elapsed}ms — bounded, not a 180s hang`);

    // A session that arrives after the timeout must still be detached, not leaked.
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(lateDetached, 'a late-arriving probe session is detached rather than leaked');
  });

  test('non-chromium browsers skip the CDP probe (pipe transport detects exit)', async (assert) => {
    let probed = false;
    const browser = {
      isConnected: () => true,
      newBrowserCDPSession: () => {
        probed = true;
        return Promise.resolve({ detach: () => Promise.resolve() });
      },
    } as unknown as ProbeBrowser;

    for (const name of ['firefox', 'webkit']) {
      assert.strictEqual(
        await Server.browserResponsive(browser, name),
        true,
        `${name} → isConnected wins`,
      );
    }
    assert.notOk(probed, 'no CDP round-trip attempted for non-chromium browsers');
  });

  test('Server.BROWSER_RELAUNCH_TIMEOUT_MS keeps the daemon the first to report', (assert) => {
    // `Browser.launch` had no bound, and it runs before handleRun installs the interceptors that
    // forward daemon output — so a launch that never returned showed up as a client with empty
    // stdout and a harness SIGTERM two and a half minutes later. Bounded below both the group
    // deadline and the client's silence budget, the daemon reports `browser recovery failed`
    // instead of everyone waiting on it.
    assert.true(
      Server.BROWSER_RELAUNCH_TIMEOUT_MS < 180_000,
      `${Server.BROWSER_RELAUNCH_TIMEOUT_MS}ms is under GROUP_TIMEOUT_MS`,
    );
    assert.true(
      Server.BROWSER_RELAUNCH_TIMEOUT_MS < Client.RUN_SILENCE_TIMEOUT_MS,
      'and under the client budget, so the daemon explains the failure rather than the client',
    );
    assert.true(
      Server.BROWSER_RELAUNCH_TIMEOUT_MS > 30_000,
      'while leaving a real launch an order of magnitude more time than it needs',
    );
  });

  test('Server.BROWSER_PROBE_TIMEOUT_MS is well under the 180s GROUP_TIMEOUT backstop', (assert) => {
    assert.ok(Server.BROWSER_PROBE_TIMEOUT_MS > 0, 'positive budget');
    assert.ok(
      Server.BROWSER_PROBE_TIMEOUT_MS <= 5_000,
      'surfaces a dead browser in seconds, not minutes',
    );
  });
});
