import { module, test } from 'qunitx';
import { browserResponsive, BROWSER_PROBE_TIMEOUT_MS } from '../../lib/commands/daemon/server.ts';
import '../helpers/custom-asserts.ts';

// Regression coverage for the CI hang where a browser killed while the daemon was idle
// still reported isConnected()===true (the CDP transport hadn't processed the close yet),
// so a run proceeded against the dead handle and wedged in an unbounded newPage() until
// the 180s GROUP_TIMEOUT. browserResponsive replaces that passive check with an active,
// bounded CDP round-trip. These stubs prove the property deterministically without a real
// Chrome: a stale isConnected + a CDP channel that never answers must resolve `false`
// WITHIN the budget — never hang.

type ProbeBrowser = Parameters<typeof browserResponsive>[0];

module('Commands | Daemon | browserResponsive', { concurrency: true }, () => {
  test('disconnected browser → false immediately, no CDP round-trip', async (assert) => {
    let probed = false;
    const browser = {
      isConnected: () => false,
      newBrowserCDPSession: () => {
        probed = true;
        return Promise.resolve({ detach: () => Promise.resolve() });
      },
    } as unknown as ProbeBrowser;

    assert.strictEqual(await browserResponsive(browser, 'chromium'), false);
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

    assert.strictEqual(await browserResponsive(browser, 'chromium'), true);
    // detach is fire-and-forget inside browserResponsive; let its microtask flush.
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
    const alive = await browserResponsive(browser, 'chromium', 20);
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
        await browserResponsive(browser, name),
        true,
        `${name} → isConnected wins`,
      );
    }
    assert.notOk(probed, 'no CDP round-trip attempted for non-chromium browsers');
  });

  test('BROWSER_PROBE_TIMEOUT_MS is well under the 180s GROUP_TIMEOUT backstop', (assert) => {
    assert.ok(BROWSER_PROBE_TIMEOUT_MS > 0, 'positive budget');
    assert.ok(BROWSER_PROBE_TIMEOUT_MS <= 5_000, 'surfaces a dead browser in seconds, not minutes');
  });
});
