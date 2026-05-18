import { module, test } from 'qunitx';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  setupWebServer,
  NOT_FOUND_HTML,
  buildErrorHTML,
  buildNoTestsHTML,
} from '../../lib/setup/web-server.ts';
import type { Config, CachedContent } from '../../lib/types.ts';

const CWD = process.cwd();

// ---------------------------------------------------------------------------
// Static file handler — 404 behaviour
// ---------------------------------------------------------------------------

module('Setup | web-server | static file 404', { concurrency: true }, () => {
  test('serves NOT_FOUND_HTML for HTML-accepting requests to missing paths', async (assert) => {
    const server = setupWebServer(makeConfig(), makeCachedContent());
    await server.listen(0);
    const port = (server._server.address() as { port: number }).port;
    try {
      const { status, body } = await get(port, '/missing-file.html', { accept: 'text/html' });
      assert.equal(status, 404);
      assert.equal(body, NOT_FOUND_HTML);
    } finally {
      await server.close();
    }
  });

  test('serves empty body for non-HTML requests to missing paths', async (assert) => {
    const server = setupWebServer(makeConfig(), makeCachedContent());
    await server.listen(0);
    const port = (server._server.address() as { port: number }).port;
    try {
      const { status, body } = await get(port, '/missing.css');
      assert.equal(status, 404);
      assert.equal(body, '', 'no body for non-HTML 404');
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Header link — all three HTML builders link "qunitx" to "/"
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WS testEnd dedup — guards against the intermittent 2x-execution flake seen
// on CI: browser/Playwright/network race that dispatches the same `testEnd`
// event twice on the same connection inside one run. COUNTER.testCount must
// stay at 1 (not 2) and a `# [qunitx] WARNING:` line must surface on stderr
// so the underlying double-fire is investigable.
// ---------------------------------------------------------------------------

module('Setup | web-server | WS testEnd dedup', { concurrency: true }, () => {
  test('duplicate testEnd on the same connection increments COUNTER exactly once', async (assert) => {
    const config = makeConfig();
    const server = setupWebServer(config, makeCachedContent());
    await server.listen(0);
    const port = (server._server.address() as { port: number }).port;

    // Capture stderr while the duplicate event flows through — the warning
    // line is the second half of the contract (counter holds AND signal fires).
    const warnings = captureStderr(async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => ws.once('open', () => resolve()));

      ws.send(JSON.stringify({ event: 'wsOpen' }));
      ws.send(JSON.stringify({ event: 'connection' }));

      const testEnd = {
        event: 'testEnd',
        details: { fullName: ['Mod', 'a test'], status: 'passed', runtime: 1, assertions: [] },
      };
      ws.send(JSON.stringify(testEnd));
      ws.send(JSON.stringify(testEnd)); // duplicate — the bug we defend against

      // Round-trip via 'done' so the server is guaranteed to have processed
      // both testEnd messages before we assert. _testRunDone wires resolves
      // the test-race promise; here we just observe done's side effect.
      const done = new Promise<void>((resolve) => {
        config._testRunDone = resolve;
      });
      ws.send(
        JSON.stringify({
          event: 'done',
          details: { passed: 1, failed: 0, runtime: 1 },
          qunitResult: { totalTests: 1, finishedTests: 1, failedTests: 0, currentTest: null },
        }),
      );
      await done;
      ws.close();
    });

    try {
      const stderr = await warnings;
      assert.equal(
        config.COUNTER.testCount,
        1,
        'COUNTER.testCount incremented once despite two testEnd events',
      );
      assert.ok(
        stderr.includes('duplicate testEnd ignored for "Mod | a test"'),
        `warning surfaced on stderr (got: ${JSON.stringify(stderr)})`,
      );
    } finally {
      await server.close();
    }
  });

  test('distinct testEnds within the same run both increment COUNTER', async (assert) => {
    const config = makeConfig();
    const server = setupWebServer(config, makeCachedContent());
    await server.listen(0);
    const port = (server._server.address() as { port: number }).port;

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => ws.once('open', () => resolve()));

      ws.send(JSON.stringify({ event: 'wsOpen' }));
      ws.send(JSON.stringify({ event: 'connection' }));

      // Two different tests — both should count. Dedup is by fullName, so
      // distinct names must NOT trip it.
      for (const name of ['test one', 'test two']) {
        ws.send(
          JSON.stringify({
            event: 'testEnd',
            details: { fullName: ['Mod', name], status: 'passed', runtime: 1, assertions: [] },
          }),
        );
      }

      const done = new Promise<void>((resolve) => {
        config._testRunDone = resolve;
      });
      ws.send(
        JSON.stringify({
          event: 'done',
          details: { passed: 2, failed: 0, runtime: 1 },
          qunitResult: { totalTests: 2, finishedTests: 2, failedTests: 0, currentTest: null },
        }),
      );
      await done;
      ws.close();

      assert.equal(config.COUNTER.testCount, 2, 'two distinct testEnds → COUNTER == 2');
    } finally {
      await server.close();
    }
  });

  test('a new connection resets the dedup set (covers watch reruns)', async (assert) => {
    const config = makeConfig();
    const server = setupWebServer(config, makeCachedContent());
    await server.listen(0);
    const port = (server._server.address() as { port: number }).port;

    try {
      const sameTestEnd = JSON.stringify({
        event: 'testEnd',
        details: { fullName: ['Mod', 'a test'], status: 'passed', runtime: 1, assertions: [] },
      });

      // First connection: one testEnd → counter goes to 1.
      const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => ws1.once('open', () => resolve()));
      ws1.send(JSON.stringify({ event: 'connection' }));
      ws1.send(sameTestEnd);
      const done1 = new Promise<void>((resolve) => {
        config._testRunDone = resolve;
      });
      ws1.send(
        JSON.stringify({
          event: 'done',
          details: { passed: 1, failed: 0, runtime: 1 },
          qunitResult: { totalTests: 1, finishedTests: 1, failedTests: 0, currentTest: null },
        }),
      );
      await done1;
      ws1.close();
      assert.equal(config.COUNTER.testCount, 1, 'first run: counter 1');

      // Second connection (watch rerun): same test name re-runs and should
      // count again because the dedup set was reset on the new 'connection'.
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => ws2.once('open', () => resolve()));
      ws2.send(JSON.stringify({ event: 'connection' }));
      ws2.send(sameTestEnd);
      const done2 = new Promise<void>((resolve) => {
        config._testRunDone = resolve;
      });
      ws2.send(
        JSON.stringify({
          event: 'done',
          details: { passed: 1, failed: 0, runtime: 1 },
          qunitResult: { totalTests: 1, finishedTests: 1, failedTests: 0, currentTest: null },
        }),
      );
      await done2;
      ws2.close();
      assert.equal(config.COUNTER.testCount, 2, 'second run: counter 2 (rerun re-counted)');
    } finally {
      await server.close();
    }
  });
});

// Replaces process.stderr.write with a buffering hook for the duration of
// `fn`. Returns the captured text on resolution. Restores the original write
// fn in finally so a thrown fn does not leak the hook.
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let buffer = '';
  process.stderr.write = ((chunk: unknown) => {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Buffer).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
    return buffer;
  } finally {
    process.stderr.write = original;
  }
}

module('Setup | web-server | header links to /', { concurrency: true }, () => {
  test('NOT_FOUND_HTML header links to /', (assert) => {
    assert.ok(
      NOT_FOUND_HTML.includes('<a href="/" style="color:inherit;text-decoration:none">qunitx</a>'),
    );
  });

  test('buildErrorHTML header links to /', (assert) => {
    const html = buildErrorHTML({ type: 'Build Error', formatted: 'some error' });
    assert.ok(html.includes('<a href="/" style="color:inherit;text-decoration:none">qunitx</a>'));
  });

  test('buildNoTestsHTML header links to /', (assert) => {
    const html = buildNoTestsHTML(['test/foo.ts']);
    assert.ok(html.includes('<a href="/" style="color:inherit;text-decoration:none">qunitx</a>'));
  });
});

function makeConfig(): Config {
  return {
    output: `tmp/ws-test-${randomUUID()}`,
    timeout: 10000,
    failFast: false,
    port: 0,
    extensions: ['ts', 'js'],
    browser: 'chromium',
    projectRoot: CWD,
    inputs: [],
    htmlPaths: [],
    testFileLookupPaths: [],
    fsTree: {},
    debug: false,
    COUNTER: {
      testCount: 0,
      failCount: 0,
      skipCount: 0,
      todoCount: 0,
      passCount: 0,
      errorCount: 0,
    },
    lastFailedTestFiles: null,
    lastRanTestFiles: null,
    _testRunDone: null,
    _resetTestTimeout: null,
    _onWsOpen: null,
    _onTestsJsServed: null,
  } as unknown as Config;
}

function makeCachedContent(): CachedContent {
  return {
    allTestCode: null,
    assets: new Set(),
    htmlPathsToRunTests: ['/'],
    mainHTML: { filePath: `${CWD}/test.html`, html: '<html><body>{{qunitxScript}}</body></html>' },
    staticHTMLs: {},
    dynamicContentHTMLs: {},
  };
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
  });
}
