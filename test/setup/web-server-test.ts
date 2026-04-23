import { module, test } from 'qunitx';
import http from 'node:http';
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
