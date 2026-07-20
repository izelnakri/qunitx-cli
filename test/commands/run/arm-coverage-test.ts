import { module, test } from 'qunitx';
import { armJSCoverage } from '../../../lib/commands/run/tests-in-browser.ts';
import '../../helpers/custom-asserts.ts';
import type { Config } from '../../../lib/types.ts';
import type { Page } from 'playwright-core';

// A failed startJSCoverage() used to be swallowed by `.catch(() => {})`. The run then finished
// normally and printed an empty coverage section with exit 0 — indistinguishable from "your code
// really is uncovered". That silence made a functional break (claiming Chrome's blank page, whose
// context Playwright does not own) look like a flake. Arming failures must be announced.
//
// The warning is asserted through an injected logger rather than by patching process.stdout:
// under Deno, console.log writes straight to Deno.stdout and never reaches the Node
// process.stdout.write shim, so a stdout capture passes on node and fails on the deno lane.

function stubPage(startJSCoverage: () => Promise<void>): Page {
  return { coverage: { startJSCoverage } } as unknown as Page;
}

const coverageConfig = (overrides: Partial<Config> = {}) =>
  ({ coverage: true, browser: 'chromium', ...overrides }) as Config;

/** Collects what armJSCoverage logs, joined the way console.log would render it. */
function spyLog(): { log: (...args: unknown[]) => void; output: () => string } {
  const lines: string[] = [];
  return {
    log: (...args: unknown[]) => lines.push(args.map(String).join(' ')),
    output: () => lines.join('\n'),
  };
}

module('Commands | run | armJSCoverage', { concurrency: true }, () => {
  test('reports armed when startJSCoverage resolves', async (assert) => {
    let options: unknown;
    const page = stubPage((opts?: unknown) => {
      options = opts;
      return Promise.resolve();
    });
    const spy = spyLog();

    assert.true(await armJSCoverage(page, coverageConfig(), spy.log), 'coverage is armed');
    assert.deepEqual(
      options,
      { resetOnNavigation: false },
      'data survives the navigation that follows',
    );
    assert.equal(spy.output(), '', 'no warning on the happy path');
  });

  test('warns instead of silently producing an empty report when arming fails', async (assert) => {
    const page = stubPage(() => Promise.reject(new Error('Target does not support coverage')));
    const spy = spyLog();

    const armed = await armJSCoverage(page, coverageConfig(), spy.log);

    assert.false(armed, 'reports that coverage never started');
    assert.includes(spy.output(), 'Warning');
    assert.includes(spy.output(), 'report will be empty');
    assert.includes(spy.output(), 'Target does not support coverage', 'surfaces the cause');
  });

  test('does not arm — or warn — when coverage was not requested', async (assert) => {
    let called = false;
    const page = stubPage(() => {
      called = true;
      return Promise.resolve();
    });
    const spy = spyLog();

    assert.false(await armJSCoverage(page, coverageConfig({ coverage: false }), spy.log));
    assert.false(called, 'startJSCoverage is never reached');
    assert.equal(spy.output(), '', 'silence is correct when the user did not ask for coverage');
  });

  test('skips non-chromium browsers, where page.coverage does not exist', async (assert) => {
    let called = false;
    const page = stubPage(() => {
      called = true;
      return Promise.resolve();
    });
    const spy = spyLog();

    assert.false(await armJSCoverage(page, coverageConfig({ browser: 'firefox' }), spy.log));
    assert.false(called, 'never touches page.coverage on firefox');
  });
});
