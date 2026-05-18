import { module, test } from 'qunitx';
import http from 'node:http';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
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

// ---------------------------------------------------------------------------
// Injected runtime script — idempotency under double-execution.
//
// Regression test for the 2× test-execution flake (CI run 26046813154 / job
// 76573047617: COUNTER = 2 * expected and the diagnostic from commit fe786a7
// fired "wss accepted connection #2"). Root cause: the runtime IIFE ran twice
// in one page load (under a sub-resource preload race observed intermittently
// on Chromium + slow CI), each invocation registered its own
// `setupWebSocket` + `QUnit.on('testEnd')`, and QUnit then fired every
// testEnd to BOTH listeners — doubling the pass count.
//
// The fix is a window-scoped sentinel that no-ops a second script execution.
// The contract: running the runtime <script> twice in one Window opens ONE
// WebSocket and registers ONE QUnit.on('testEnd'). Without the guard, both
// counters are 2 — exactly the production failure shape.
// ---------------------------------------------------------------------------

module('Setup | web-server | runtime IIFE idempotency', { concurrency: true }, () => {
  test('a second invocation in the same Window opens exactly one WebSocket', async (assert) => {
    // Fetch the actual served HTML so the test exercises the runtime script
    // produced by testRuntimeToInject(), not a hand-typed copy.
    const server = setupWebServer(makeConfig(), makeCachedContent());
    await server.listen(0);
    const port = (server._server.address() as { port: number }).port;
    let runtimeJs: string;
    try {
      const { body } = await get(port, '/', { accept: 'text/html' });
      // The runtime is the first <script>...</script> block in the served HTML
      // (the bundle that follows it has `src=` and no body). Non-greedy match
      // stops at the first </script> which is the runtime's closer.
      const match = body.match(/<script>([\s\S]+?)<\/script>/);
      assert.ok(match, 'served HTML contains the runtime <script> block');
      runtimeJs = match![1];
      assert.ok(
        runtimeJs.includes('__QUNITX_RUNTIME_INIT__'),
        'runtime script contains the idempotency sentinel',
      );
    } finally {
      await server.close();
    }

    // The setupWebSocket() call inside the IIFE is synchronous and runs at
    // module-init time — no Promise.all wait, no event listener firing. So
    // the WS-constructor count after running the script is a direct
    // observation of "did the IIFE body execute?". Without the guard, the
    // second eval re-runs the IIFE and constructs a SECOND WebSocket; with
    // the guard, the second eval short-circuits and the count stays at 1.
    // QUnit.on('testEnd') registration is gated on Promise.all resolution
    // (which never happens in this sandbox), so it's not asserted here —
    // the IIFE-execution count alone is sufficient to catch the regression.
    const wsConstructorCalls: string[] = [];
    class FakeWebSocket {
      readyState = 0;
      constructor(url: string) {
        wsConstructorCalls.push(url);
      }
      addEventListener() {}
      send() {}
      close() {}
    }
    const fakeWindow = {
      location: { protocol: 'http:', port: '1234' },
      addEventListener: () => {},
      setTimeout: setTimeout,
    } as Record<string, unknown>;
    fakeWindow.window = fakeWindow;
    // Browser globals are exposed both as `window.foo` AND bare `foo`
    // (location, navigator, WebSocket, setTimeout, etc.) — the runtime uses
    // both forms (e.g. `window.location.protocol` and `location.port`), so
    // mirror them at sandbox top level.
    const sandbox = {
      window: fakeWindow,
      location: fakeWindow.location,
      WebSocket: FakeWebSocket,
      navigator: { webdriver: true },
      console: { log: () => {} },
      setTimeout: setTimeout,
      Promise: Promise,
    };
    vm.createContext(sandbox);

    vm.runInContext(runtimeJs, sandbox);
    assert.equal(wsConstructorCalls.length, 1, 'first invocation constructed one WebSocket');
    assert.true(
      Boolean((fakeWindow as { __QUNITX_RUNTIME_INIT__?: boolean }).__QUNITX_RUNTIME_INIT__),
      'sentinel set after the first invocation',
    );

    vm.runInContext(runtimeJs, sandbox);
    assert.equal(
      wsConstructorCalls.length,
      1,
      `second invocation MUST NOT construct another WebSocket (got ${wsConstructorCalls.length}) — without the guard this would be 2, the exact CI 26046813154 failure shape`,
    );
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
