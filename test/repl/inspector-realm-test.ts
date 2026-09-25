import path from 'node:path';
import { module, test } from 'qunitx';
import { inspectorRealm } from '../../lib/repl/inspector-realm.ts';
import { importPlaywrightCore } from '../../lib/utils/import-playwright-core.ts';
import '../helpers/custom-asserts.ts';

const ROOT = path.resolve(import.meta.dirname!, '..', '..');
// Stands in for the real prompt prelude, which is three stringified functions.
const PRELUDE = 'globalThis.__qunitxPreludeRan = true;';

module('Repl | inspector realm', () => {
  test('it is a realm: ask it something, and it answers', async (assert) => {
    const realm = await inspectorRealm('node', ROOT, PRELUDE);
    try {
      await realm.send('Runtime.enable');
      await realm.send('Debugger.enable');
      await realm.release();

      const answer = await realm.send<{ result: { value?: unknown } }>('Runtime.evaluate', {
        expression: '2 ** 10',
        returnByValue: true,
      });

      assert.strictEqual(answer.result.value, 1024);
      assert.true(realm.alive());
      assert.strictEqual(realm.runtime, 'node');
    } finally {
      await realm.detach();
      await Promise.all(Object.values(realm.closing()));
    }
  });

  // The bug this is here for: `runIfWaitingForDebugger` alone leaves a process that LOOKS
  // attached — synchronous evaluations answer normally — and whose event loop has never started,
  // so the first `await` never comes back. It cost two rounds of "the inspector must be broken".
  test('release installs the prelude and starts the event loop', async (assert) => {
    const realm = await inspectorRealm('node', ROOT, PRELUDE);
    try {
      await realm.send('Runtime.enable');
      await realm.send('Debugger.enable');
      await realm.release();

      const prelude = await realm.send<{ result: { value?: unknown } }>('Runtime.evaluate', {
        expression: 'globalThis.__qunitxPreludeRan',
        returnByValue: true,
      });
      assert.true(prelude.result.value, 'the prelude ran');

      const awaited = await realm.send<{ result: { value?: unknown } }>('Runtime.evaluate', {
        expression: 'new Promise((done) => setTimeout(() => done("the loop turned"), 20))',
        awaitPromise: true,
        returnByValue: true,
      });
      assert.strictEqual(awaited.result.value, 'the loop turned', 'timers fire, so awaits return');
    } finally {
      await realm.detach();
      await Promise.all(Object.values(realm.closing()));
    }
  });

  test('a dead runtime is not alive, and says so rather than hanging', async (assert) => {
    const realm = await inspectorRealm('node', ROOT, PRELUDE);
    await realm.detach();
    await Promise.all(Object.values(realm.closing()));

    assert.false(realm.alive());
  });

  // The headline, and the one shape a unit test cannot fake: Chrome's OWN DevTools frontend,
  // served over plain HTTP, attaching to a node process. Driven end to end because every cheaper
  // version of this test passes while the feature is broken — the frontend is a single-page app
  // that fails silently when the `ws=` parameter is wrong.
  test("Chrome's DevTools attaches to the runtime through the served URL", async (assert) => {
    const realm = await inspectorRealm('node', ROOT, PRELUDE);
    const playwright = await importPlaywrightCore();
    try {
      await realm.send('Runtime.enable');
      await realm.send('Debugger.enable');
      await realm.release();

      const url = await realm.devtoolsURL();
      assert.ok(url, 'there is an address to open');
      assert.includes(url!, 'v8only=true', 'the frontend is told it is looking at a runtime');
      assert.includes(url!, '/devtools/js_app.html');
      assert.notIncludes(url!, 'ws=ws://', 'the ws parameter carries no scheme');

      // Chrome serves the frontend document itself, from its remote-debugging port.
      const served = await fetch(url!.split('?')[0]!);
      assert.strictEqual(served.status, 200, 'Chrome serves the frontend at that path');

      // Opened in the very Chrome that is serving it — the realm already started one, and a
      // second would be two browsers to prove one point.
      const browser = await playwright.chromium.connectOverCDP({
        endpointURL: new URL(url!).origin,
        timeout: 15_000,
      });
      const page = await browser.newPage();
      await page.goto(url!, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForTimeout(4_000);

      assert.strictEqual(await page.title(), 'DevTools', 'the frontend itself loaded');
      // The frontend having attached means the runtime now has a debugger on it, which is
      // observable from OUR side of the socket: a second client makes the pause state shared.
      const attached = await realm.send<{ result: { value?: unknown } }>('Runtime.evaluate', {
        expression: 'typeof globalThis.__qunitxImport',
        returnByValue: true,
      });
      assert.strictEqual(attached.result.value, 'function', 'our own socket still works alongside');

      await browser.close();
    } finally {
      await realm.detach();
      await Promise.all(Object.values(realm.closing()));
    }
  });
});
