import { module, test } from 'qunitx';
import { armJSCoverage } from '../../../lib/commands/run/tests-in-browser.ts';
import '../../helpers/custom-asserts.ts';
import type { Config } from '../../../lib/types.ts';
import type { Page } from 'playwright-core';

// A failed startJSCoverage() used to be swallowed by `.catch(() => {})`. The run then finished
// normally and printed an empty coverage section with exit 0 — indistinguishable from "your code
// really is uncovered". That silence made a functional break (claiming Chrome's blank page, whose
// context Playwright does not own) look like a flake. Arming failures must be announced.

function stubPage(startJSCoverage: () => Promise<void>): Page {
  return { coverage: { startJSCoverage } } as unknown as Page;
}

// captureStdout in test/helpers is synchronous; armJSCoverage is not, so the override has to
// span an await. That is why this module runs serially — with concurrency the runner's own TAP
// writes would land inside the capture window and be swallowed.
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string }> {
  let stdout = '';
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (chunk: string) => {
    stdout += chunk;
    return true;
  };
  try {
    return { result: await fn(), stdout };
  } finally {
    process.stdout.write = original;
  }
}

const coverageConfig = (overrides: Partial<Config> = {}) =>
  ({ coverage: true, browser: 'chromium', ...overrides }) as Config;

module('Commands | run | armJSCoverage', { concurrency: false }, () => {
  test('reports armed when startJSCoverage resolves', async (assert) => {
    let options: unknown;
    const page = stubPage((opts?: unknown) => {
      options = opts;
      return Promise.resolve();
    });

    const { result, stdout } = await capture(() => armJSCoverage(page, coverageConfig()));

    assert.true(result, 'coverage is armed');
    assert.deepEqual(
      options,
      { resetOnNavigation: false },
      'data survives the navigation that follows',
    );
    assert.equal(stdout, '', 'no warning on the happy path');
  });

  test('warns instead of silently producing an empty report when arming fails', async (assert) => {
    const page = stubPage(() => Promise.reject(new Error('Target does not support coverage')));

    const { result, stdout } = await capture(() => armJSCoverage(page, coverageConfig()));

    assert.false(result, 'reports that coverage never started');
    assert.includes(stdout, 'Warning');
    assert.includes(stdout, 'report will be empty');
    assert.includes(stdout, 'Target does not support coverage', 'surfaces the underlying cause');
  });

  test('does not arm — or warn — when coverage was not requested', async (assert) => {
    let called = false;
    const page = stubPage(() => {
      called = true;
      return Promise.resolve();
    });

    const { result, stdout } = await capture(() =>
      armJSCoverage(page, coverageConfig({ coverage: false })),
    );

    assert.false(result);
    assert.false(called, 'startJSCoverage is never reached');
    assert.equal(stdout, '', 'silence is correct when the user did not ask for coverage');
  });

  test('skips non-chromium browsers, where page.coverage does not exist', async (assert) => {
    let called = false;
    const page = stubPage(() => {
      called = true;
      return Promise.resolve();
    });

    const { result } = await capture(() =>
      armJSCoverage(page, coverageConfig({ browser: 'firefox' })),
    );

    assert.false(result);
    assert.false(called, 'never touches page.coverage on firefox');
  });
});
