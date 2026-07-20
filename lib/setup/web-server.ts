import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { findInternalAssetsFromHTML } from '../utils/find-internal-assets-from-html.ts';
import { injectScript } from '../utils/html.ts';
import { reportRunStart, reportTestEnd } from '../reporter/index.ts';
import { recordFailedTest } from '../utils/failure-cache.ts';
import { isFilteredRun } from '../selection/filter-query.ts';
import { blue } from '../utils/color.ts';
import { HTTPServer, MIME_TYPES } from '../servers/web.ts';
import { createReconnectingSocket } from './ws-client.js';
import { readTemplate } from '../utils/read-template.ts';
import type { Config } from '../types.ts';

const fsPromise = fs.promises;

const HTML_HEADERS = { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } as const;

// Browser-side WebSocket reconnect parameters injected into watch-mode HTML pages.
const WATCH_WS_RECONNECT_INTERVAL_MS = 1_000;
const WATCH_WS_RECONNECT_MAX_RETRIES = 120;
// Retry interval for the QUnit page's WebSocket setup attempts (ms).
const WS_RETRY_INTERVAL_MS = 10;

// Writes a diagnostic warning to BOTH stdout and stderr. stderr is the natural
// stream for warnings but is captured-then-discarded by many test helpers
// (e.g. test/inputs/plugins-test.ts's runFixtureCli), making warnings invisible
// when a test fails. stdout writes the same text as a TAP `#` comment — TAP
// parsers ignore `#` lines, so it does not affect test outcomes, and assertion-
// failure dumps that snapshot stdout (custom-asserts.tapResult) now include the
// warning surface. Dual write keeps either stream a sufficient signal in CI
// logs.
function diagWrite(msg: string): void {
  process.stderr.write(msg);
  process.stdout.write(msg);
}

/** Static 404 page served for HTML-accepting requests to missing static assets. */
const NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <title>404 Not Found \u2014 qunitx</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:"Helvetica Neue Light","HelveticaNeue-Light","Helvetica Neue",Calibri,Helvetica,Arial,sans-serif}
    #qunit-header{padding:.5em 0 .5em 1em;color:#C2CCD1;background-color:#0D3349;font-size:1.5em;line-height:1em;font-weight:400;border-radius:5px 5px 0 0}
    #qunit-banner{height:5px;background-color:#EE5757}
    #qunit-userAgent{padding:.5em 1em;color:#fff;background-color:#2B81AF;text-shadow:rgba(0,0,0,.5) 2px 2px 1px;font-size:small}
    #qunit-tests{list-style:none;font-size:smaller}
    #qunit-tests li{display:list-item;padding:.4em 1em;color:#000;background-color:#EE5757;border-radius:0 0 5px 5px}
  </style>
</head>
<body>
  <div id="qunit">
    <h1 id="qunit-header"><a href="/" style="color:inherit;text-decoration:none">qunitx</a></h1>
    <h2 id="qunit-banner"></h2>
    <div id="qunit-userAgent">404 Not Found</div>
    <ol id="qunit-tests">
      <li id="qunit-testresult"><script>document.getElementById('qunit-testresult').prepend(location.pathname)</script> was not found on this server.</li>
    </ol>
  </div>
</body>
</html>`;

/**
 * Creates and returns an HTTPServer with routes for the test HTML, filtered test page, and static assets, plus a WebSocket handler that streams TAP events.
 * @returns {object}
 */
export function setupWebServer(config: Config): HTTPServer {
  const cachedContent = config.state.group.build;
  const STATIC_FILES_PATH = path.resolve(config.projectRoot, config.output);
  const consumerQunitCssCandidate = resolveConsumerQunitCssCandidate(config.projectRoot);
  const server = new HTTPServer();
  const mainHTMLWithReplacedAssets = replaceAssetPaths(
    config.state.htmlAssets.mainHTML.html,
    config.state.htmlAssets.mainHTML.filePath,
    config.projectRoot,
  );
  // Cache the runtime script and both normal HTML responses — stable for this server's lifetime.
  const runtimeScript = testRuntimeToInject(config);
  const mainIndexHTML = escapeAndInjectTestsToHTML(
    mainHTMLWithReplacedAssets,
    runtimeScript,
    './tests.js',
  );
  const mainQunitxHTML = escapeAndInjectTestsToHTML(
    mainHTMLWithReplacedAssets,
    runtimeScript,
    './filtered-tests.js',
  );
  const saveHTML = (filePath: string, html: string) =>
    fsPromise
      .writeFile(filePath, html)
      .catch(
        (err: Error) =>
          config.debug &&
          process.stderr.write(`# [qunitx] writeFile ${filePath}: ${err.message}\n`),
      );

  config.state.group.wsConnectionCount = 0;
  server.wss.on('connection', function connection(socket) {
    config.state.group.wsConnectionCount = (config.state.group.wsConnectionCount ?? 0) + 1;
    // A second WS connection is expected in watch/--open mode — the user opening http://localhost:PORT
    // in their own browser (the watch banner invites it) or a headed reload — so warning there is
    // noise. In a plain single run (e.g. CI) the lone headless page must connect exactly once, so a
    // duplicate is the real tell for the 2× testEnd flake (WS retry race). --debug forces it on for
    // investigating a watch-mode double-connect.
    if (
      config.state.group.wsConnectionCount > 1 &&
      (config.debug || !(config.watch || config.open))
    ) {
      diagWrite(
        `# [qunitx][diag] wss accepted connection #${config.state.group.wsConnectionCount} — ` +
          `single-group runs should see exactly one WS connection per run. ` +
          `Multiple connections from one page are the prime suspect for the 2× testEnd flake ` +
          `(WS retry race in the injected runtime).\n`,
      );
    }
    socket.on('message', function message(data) {
      const { event, details, qunitResult, abort } = JSON.parse(data);

      if (event === 'wsOpen') {
        // WebSocket socket opened — test bundle is still compiling in the background.
        // Signal Node.js so it can flip wsConnected for accurate TIMEOUT diagnostics
        // without resetting the per-test timer (that happens on 'connection' below).
        config.state.group.phase = 'loading';
        config.state.group.signals.onWsOpen?.();
      } else if (event === 'connection') {
        config.state.group.phase = 'running';
        // Dedup map reset is owned by runTestsInBrowser (alongside the counter
        // reset), NOT this WS handler. Resetting on every 'connection' was
        // the bug that broke no-html-test in CI run 26042614416: a stale
        // testEnd arriving just after `connection` for a watch rerun got
        // counted spuriously because the dedup map had been wiped. The map
        // is now reset only at the same lifecycle boundary as the counter.
        // Group and daemon runs emit run-start once up front in run.ts; only the watch/single
        // path announces per browser connection (each rerun opens a fresh one).
        if (!config.state.group.groupMode && !config.state.daemon) {
          reportRunStart(config, { fileCount: null, groupCount: null });
        }
        if (config.debug && config.state.group.groupMode) debugGroupHeader(config);
        config.state.group.signals.resetTestTimeout?.();
      } else if (event === 'testEnd' && !abort) {
        // Server-side enforcement of "QUnit fires testEnd exactly once per
        // registered test per run." The 2× flake (CI runs 26046813154 and
        // 26077472287) ships a duplicate testEnd via the same WS connection
        // through paths we cannot fully trace from outside the browser
        // (WS-retry race + sub-resource preload race observed on webkit /
        // macOS / Deno-compiled binary). Dedup makes the contract explicit
        // and load-bearing: the second arrival of any fullName in the
        // current run is dropped with a loud warning so the underlying
        // browser/runtime bug stays visible while the counter stays correct.
        const fullName = details.fullName.join(' | ');
        const count = (config.state.group.testEndCounts?.get(fullName) ?? 0) + 1;
        config.state.group.testEndCounts?.set(fullName, count);
        if (count > 1) {
          diagWrite(
            `# [qunitx] WARNING: duplicate testEnd ignored for "${fullName}" — ` +
              `browser/Playwright fired the event twice in one run. ` +
              `Counter not incremented; see Config.state.group.testEndCounts for details.\n`,
          );
          return;
        }

        if (details.status === 'failed') {
          config.state.group.lastFailedFiles = config.state.group.ranFiles;
          recordFailedTest(config, details);
        }

        if (config.debug && details.runtime > config.timeout * 0.8) {
          process.stdout.write(
            `# SLOW (${details.runtime.toFixed(0)}ms / ${config.timeout}ms timeout): ${details.fullName.join(' | ')}\n`,
          );
        }
        config.state.group.signals.resetTestTimeout?.();
        reportTestEnd(config, details);
      } else if (event === 'done') {
        // Signal test completion. TCP ordering guarantees all testEnd messages
        // preceding this on the same connection are already processed by Node.js.
        config.state.group.phase = 'done';
        // Store the browser-side QUNIT_RESULT so runTestInsideHTMLFile can read it
        // without a page.evaluate() CDP round-trip after testRaceResult resolves.
        config.state.group.lastQUnitResult = qunitResult ?? null;
        if (config.debug && config.state.group.groupMode) {
          process.stdout.write(
            `# group done: ${details.passed} passed, ${details.failed} failed (${details.runtime}ms)\n`,
          );
        }
        if (typeof config.state.group.signals.testRunDone === 'function') {
          config.state.group.signals.testRunDone();
          config.state.group.signals.testRunDone = null;
        }
      }
    });
  });

  // Serve the compiled test bundle and (when filtering) the filtered bundle as separate
  // JS files. This lets Chrome compile them in background threads while the main thread
  // is free to process the WebSocket 'open' event, decoupling WS connection time from
  // bundle compilation time and eliminating the "WS never connected" timeout on CI.
  server.get('/tests.js', async (_req, res) => {
    // In watch-mode reruns, build and navigation race in parallel. Hold the response until
    // esbuild settles. On build failure, send a WS done signal with 0 tests so the test
    // race resolves immediately rather than waiting for the startup timeout.
    if (cachedContent._activeRebuild) {
      await cachedContent._activeRebuild.catch(() => {});
      if (!cachedContent.allTestCode) {
        // Resolve testRaceResult from Node.js directly — the WS may not be open yet
        // when this script executes on CI (Chrome can fetch tests.js before the WS
        // handshake completes), making the browser-side readyState guard unreliable.
        config.state.group.lastQUnitResult = {
          totalTests: 0,
          finishedTests: 0,
          failedTests: 0,
          currentTest: null,
        };
        config.state.group.signals.testRunDone?.();
        config.state.group.signals.testRunDone = null;
        res.writeHead(200, {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'no-store',
        });
        return void res.end();
      }
    }
    const bytes = cachedContent.allTestCode?.length ?? null;
    config.debug &&
      process.stdout.write(
        `# [HTTPServer] GET /tests.js → ${bytes !== null ? `${bytes} bytes` : 'NOT READY (allTestCode is null)'}\n`,
      );
    if (bytes === null) {
      // allTestCode not yet built — serve a JS error so Chrome logs a visible message
      // instead of silently executing an empty script. This should never happen in
      // normal operation (buildTestBundle is always awaited before navigation), but
      // guards against unexpected race conditions.
      res.writeHead(503, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      return void res.end(
        'console.error("[qunitx] /tests.js requested before bundle was built — allTestCode is null");',
      );
    }
    // Signal Node.js that Chrome has fetched the bundle. Resets the idle timer so Chrome
    // gets a fresh budget to compile and execute tests.js — decoupled from WS open time.
    config.state.group.signals.onTestsJsServed?.();
    res.writeHead(200, {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-store',
      'Content-Length': bytes,
    });
    res.end(cachedContent.allTestCode);
  });

  // Serve qunit.css preferring the consumer's installed qunitx, falling back to the CLI's embedded
  // copy so projects don't need to `npm install qunitx` (mirrors the JS runtime plugin's
  // resolve-first precedence). The generated tests.html links ../node_modules/qunitx/vendor/
  // qunit.css, which resolves to this root URL (single- and group-mode pages both land here).
  server.get('/node_modules/qunitx/vendor/qunit.css', async (_req, res) => {
    const consumer = consumerQunitCssCandidate
      ? await fsPromise.readFile(consumerQunitCssCandidate).catch(() => null)
      : null;
    res.writeHead(200, { 'Content-Type': MIME_TYPES.css, 'Cache-Control': 'no-store' });
    res.end(consumer ?? (await readTemplate('vendor/qunit.css')));
  });

  server.get('/filtered-tests.js', (_req, res) => {
    const bytes = cachedContent.filteredTestCode?.length ?? null;
    config.debug &&
      process.stdout.write(
        `# [HTTPServer] GET /filtered-tests.js → ${bytes !== null ? `${bytes} bytes` : 'NOT READY (filteredTestCode is null)'}\n`,
      );
    if (bytes === null) {
      res.writeHead(503, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      return res.end(
        'console.error("[qunitx] /filtered-tests.js requested before bundle was built — filteredTestCode is null");',
      );
    }
    config.state.group.signals.onTestsJsServed?.();
    res.writeHead(200, {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-store',
      'Content-Length': bytes,
    });
    res.end(cachedContent.filteredTestCode);
  });

  server.get('/', async (_req, res) => {
    // buildTestBundle clears pageOverride only after its first await (fs.mkdir), so a stale
    // error from the previous run can persist into the next run's navigation window.
    // Awaiting _activeRebuild here ensures we act on the settled build state, not stale state.
    await cachedContent._activeRebuild?.catch(() => {});
    const override = cachedContent.pageOverride;
    if (override?.kind === 'build-error') {
      const htmlContent = buildErrorHTML(override.error);
      res.writeHead(200, HTML_HEADERS);
      res.end(htmlContent);
      // Build error HTML has no tests.js script tag, so the /tests.js route never fires.
      // Resolve testRaceResult from Node.js directly when a parallel build was in-flight.
      if (cachedContent._activeRebuild) {
        config.state.group.lastQUnitResult = {
          totalTests: 0,
          finishedTests: 0,
          failedTests: 0,
          currentTest: null,
        };
        config.state.group.signals.testRunDone?.();
        config.state.group.signals.testRunDone = null;
      }
      return saveHTML(
        path.join(path.resolve(config.projectRoot, config.output), 'index.html'),
        htmlContent,
      );
    }
    if (override?.kind === 'no-tests') {
      res.writeHead(200, HTML_HEADERS);
      return res.end(buildNoTestsHTML(override.files));
    }
    res.writeHead(200, HTML_HEADERS);
    res.end(mainIndexHTML);
    saveHTML(
      path.join(path.resolve(config.projectRoot, config.output), 'index.html'),
      mainIndexHTML,
    );
  });

  server.get('/qunitx.html', (_req, res) => {
    const override = cachedContent.pageOverride;
    if (override?.kind === 'build-error') {
      const htmlContent = buildErrorHTML(override.error);
      res.writeHead(200, HTML_HEADERS);
      res.end(htmlContent);
      return saveHTML(
        path.join(path.resolve(config.projectRoot, config.output), 'qunitx.html'),
        htmlContent,
      );
    }
    if (override?.kind === 'no-tests') {
      res.writeHead(200, HTML_HEADERS);
      return res.end(buildNoTestsHTML(override.files));
    }
    res.writeHead(200, HTML_HEADERS);
    res.end(mainQunitxHTML);
    saveHTML(
      path.join(path.resolve(config.projectRoot, config.output), 'qunitx.html'),
      mainQunitxHTML,
    );
  });

  server.get('/*', (req, res) => {
    const possibleDynamicHTML =
      config.state.htmlAssets.dynamicContentHTMLs[`${config.projectRoot}${req.path}`];
    if (possibleDynamicHTML) {
      const htmlContent = escapeAndInjectTestsToHTML(
        possibleDynamicHTML,
        runtimeScript,
        '/tests.js',
      );
      res.writeHead(200, HTML_HEADERS);
      res.end(htmlContent);
      saveHTML(path.join(path.resolve(config.projectRoot, config.output), req.path), htmlContent);
      return;
    }

    const url = req.url;
    const requestStartedAt = Date.now();
    const filePath = (
      url.endsWith('/') ? [STATIC_FILES_PATH, url, 'index.html'] : [STATIC_FILES_PATH, url]
    ).join('');
    const contentType = req.headers.accept?.includes('text/html')
      ? MIME_TYPES.html
      : MIME_TYPES[path.extname(filePath).substring(1).toLowerCase()] || MIME_TYPES.html;
    const stream = fs.createReadStream(filePath);
    stream.on('open', () => {
      res.writeHead(200, { 'Content-Type': contentType });
      stream.pipe(res);
      config.debug &&
        process.stdout.write(
          `# [HTTPServer] GET ${url} 200 - ${Date.now() - requestStartedAt}ms\n`,
        );
    });
    stream.on('error', () => {
      res.writeHead(404, { 'Content-Type': contentType });
      res.end(contentType === MIME_TYPES.html ? NOT_FOUND_HTML : undefined);
      config.debug &&
        process.stdout.write(
          `# [HTTPServer] GET ${url} 404 - ${Date.now() - requestStartedAt}ms\n`,
        );
    });
  });

  return server;
}

/**
 * Generates a self-contained HTML warning page shown when a test run completes with 0 registered
 * QUnit tests. Styled to match the QUnit HTML reporter, with an amber banner instead of red.
 * Includes the same WebSocket reconnect script as buildErrorHTML so the page reloads on the
 * next successful build.
 */
export function buildNoTestsHTML(files: string[]): string {
  const escaped = files
    .map((f) => f.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <title>No Tests Registered \u2014 qunitx</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    #qunit-header, #qunit-banner, #qunit-userAgent, #qunit-testresult, #qunit-tests, #qunit-tests li {
      font-family: "Helvetica Neue Light", "HelveticaNeue-Light", "Helvetica Neue", Calibri, Helvetica, Arial, sans-serif;
    }
    #qunit-header {
      padding: 0.5em 0 0.5em 1em;
      color: #C2CCD1;
      background-color: #0D3349;
      font-size: 1.5em;
      line-height: 1em;
      font-weight: 400;
      border-radius: 5px 5px 0 0;
    }
    #qunit-banner { height: 5px; background-color: #F0AD4E; }
    #qunit-userAgent {
      padding: 0.5em 1em;
      color: #fff;
      background-color: #EC971F;
      text-shadow: rgba(0,0,0,.3) 2px 2px 1px;
      font-size: small;
    }
    #qunit-tests { list-style: none; font-size: smaller; }
    #qunit-tests li.warn {
      display: list-item;
      padding: 0.4em 1em;
      border-bottom: 1px solid #fff;
      color: #000;
      background-color: #FCF8E3;
      border-left: 5px solid #F0AD4E;
    }
    #qunit-tests li.warn:last-child { border-radius: 0 0 5px 5px; }
    .qunit-assert-list { margin-top: 0.5em; padding: 0.5em; background-color: #fff; border-radius: 5px; list-style: none; }
    .qunit-assert-list > li {
      padding: 5px;
      background-color: #FFF8DC;
      border-left: 10px solid #F0AD4E;
      color: #8A6D3B;
    }
    .qunit-assert-list pre {
      font-family: Menlo, Monaco, Consolas, "Courier New", monospace;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      color: #8A6D3B;
      margin: 0;
    }
    #qunit-testresult {
      padding: 0.5em 1em;
      color: #366097;
      background-color: #E2F0F7;
      border-bottom: 1px solid #fff;
      font-size: small;
    }
    .dots span { display: inline-block; animation: pulse 1.4s ease-in-out infinite; }
    .dots span:nth-child(2) { animation-delay: .2s; }
    .dots span:nth-child(3) { animation-delay: .4s; }
    @keyframes pulse { 0%,100% { opacity: .2; } 50% { opacity: 1; } }
  </style>
</head>
<body>
  <div id="qunit">
    <h1 id="qunit-header"><a href="/" style="color:inherit;text-decoration:none">qunitx</a></h1>
    <h2 id="qunit-banner"></h2>
    <div id="qunit-userAgent">Warning: No Tests Registered</div>
    <ol id="qunit-tests">
      <li class="warn">
        <strong>0 QUnit tests were registered in the bundled file(s)</strong>
        <ol class="qunit-assert-list">
          <li><pre>${escaped}</pre></li>
        </ol>
      </li>
    </ol>
    <div id="qunit-testresult">
      Watching for changes&nbsp;<span class="dots"><span>&#9679;</span><span>&#9679;</span><span>&#9679;</span></span>
    </div>
  </div>
  <script>
    if (location.port) {
      (function () {
        var retries = 0;
        function connect() {
          var ws = new WebSocket(\`ws://\${location.hostname}:\${location.port}\`);
          ws.addEventListener('message', function (e) { if (e.data === 'refresh' && !navigator.webdriver) location.reload(true); });
          ws.addEventListener('close', function () { if (retries++ < ${WATCH_WS_RECONNECT_MAX_RETRIES}) setTimeout(connect, ${WATCH_WS_RECONNECT_INTERVAL_MS}); });
          ws.addEventListener('error', function () { ws.close(); });
        }
        connect();
      })();
    }
  </script>
</body>
</html>`;
}

/**
 * Generates a self-contained HTML error page for a build failure, styled to match the QUnit
 * HTML reporter (same element IDs, colors, and layout as qunit.css / qunitjs.com).
 * Includes a WebSocket reconnect script that reloads the page on 'refresh' (next successful
 * build). Uses `location.port` so no port needs to be baked in at generation time; the script
 * is a no-op when the page is opened as a static file (location.port is empty).
 */
export function buildErrorHTML(buildError: { type: string; formatted: string }): string {
  const escaped = buildError.formatted
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <title>Build Error \u2014 qunitx</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    #qunit-header, #qunit-banner, #qunit-userAgent, #qunit-testresult, #qunit-tests, #qunit-tests li {
      font-family: "Helvetica Neue Light", "HelveticaNeue-Light", "Helvetica Neue", Calibri, Helvetica, Arial, sans-serif;
    }
    #qunit-header {
      padding: 0.5em 0 0.5em 1em;
      color: #C2CCD1;
      background-color: #0D3349;
      font-size: 1.5em;
      line-height: 1em;
      font-weight: 400;
      border-radius: 5px 5px 0 0;
    }
    #qunit-banner { height: 5px; background-color: #EE5757; }
    #qunit-userAgent {
      padding: 0.5em 1em;
      color: #fff;
      background-color: #2B81AF;
      text-shadow: rgba(0,0,0,.5) 2px 2px 1px;
      font-size: small;
    }
    #qunit-tests { list-style: none; font-size: smaller; }
    #qunit-tests li.fail {
      display: list-item;
      padding: 0.4em 1em;
      border-bottom: 1px solid #fff;
      color: #000;
      background-color: #EE5757;
    }
    #qunit-tests li.fail:last-child { border-radius: 0 0 5px 5px; }
    .qunit-assert-list { margin-top: 0.5em; padding: 0.5em; background-color: #fff; border-radius: 5px; list-style: none; }
    .qunit-assert-list > li {
      padding: 5px;
      background-color: #fff;
      border-left: 10px solid #EE5757;
      color: #710909;
    }
    .qunit-assert-list pre {
      font-family: Menlo, Monaco, Consolas, "Courier New", monospace;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      color: #710909;
      margin: 0;
    }
    #qunit-testresult {
      padding: 0.5em 1em;
      color: #366097;
      background-color: #E2F0F7;
      border-bottom: 1px solid #fff;
      font-size: small;
    }
    .dots span { display: inline-block; animation: pulse 1.4s ease-in-out infinite; }
    .dots span:nth-child(2) { animation-delay: .2s; }
    .dots span:nth-child(3) { animation-delay: .4s; }
    @keyframes pulse { 0%,100% { opacity: .2; } 50% { opacity: 1; } }
  </style>
</head>
<body>
  <div id="qunit">
    <h1 id="qunit-header"><a href="/" style="color:inherit;text-decoration:none">qunitx</a></h1>
    <h2 id="qunit-banner"></h2>
    <div id="qunit-userAgent">Build Error: ${buildError.type}</div>
    <ol id="qunit-tests">
      <li class="fail">
        <strong>esbuild failed to bundle test files</strong>
        <ol class="qunit-assert-list">
          <li><pre>${escaped}</pre></li>
        </ol>
      </li>
    </ol>
    <div id="qunit-testresult">
      Watching for changes&nbsp;<span class="dots"><span>&#9679;</span><span>&#9679;</span><span>&#9679;</span></span>
    </div>
  </div>
  <script>
    if (location.port) {
      (function () {
        var retries = 0;
        function connect() {
          var ws = new WebSocket(\`ws://\${location.hostname}:\${location.port}\`);
          ws.addEventListener('message', function (e) { if (e.data === 'refresh' && !navigator.webdriver) location.reload(true); });
          ws.addEventListener('close', function () { if (retries++ < ${WATCH_WS_RECONNECT_MAX_RETRIES}) setTimeout(connect, ${WATCH_WS_RECONNECT_INTERVAL_MS}); });
          ws.addEventListener('error', function () { ws.close(); });
        }
        connect();
      })();
    }
  </script>
</body>
</html>`;
}

/**
 * Registers HTML and JS bundle routes for one concurrent group on a shared HTTPServer.
 * Routes: `GET /group-${groupId}/` and `GET /group-${groupId}/tests.js`.
 */
export function registerGroupRoutes(server: HTTPServer, groupConfig: Config): void {
  const groupId = groupConfig.state.group.index;
  const consumerQunitCssCandidate = resolveConsumerQunitCssCandidate(groupConfig.projectRoot);
  const mainHTMLWithReplacedAssets = replaceAssetPaths(
    groupConfig.state.htmlAssets.mainHTML.html!,
    groupConfig.state.htmlAssets.mainHTML.filePath!,
    groupConfig.projectRoot,
  );
  const runtimeScript = testRuntimeToInject(groupConfig, groupId);
  const mainGroupHTML = escapeAndInjectTestsToHTML(
    mainHTMLWithReplacedAssets,
    runtimeScript,
    './tests.js',
  );
  const saveHTML = (filePath: string, html: string) =>
    fsPromise
      .writeFile(filePath, html)
      .catch(
        (err: Error) =>
          groupConfig.debug &&
          process.stderr.write(`# [qunitx] writeFile ${filePath}: ${err.message}\n`),
      );

  server.get(`/group-${groupId}/`, (_req, res) => {
    const override = groupConfig.state.group.build.pageOverride;
    if (override?.kind === 'build-error') {
      res.writeHead(200, HTML_HEADERS);
      return res.end(buildErrorHTML(override.error));
    }
    if (override?.kind === 'no-tests') {
      res.writeHead(200, HTML_HEADERS);
      return res.end(buildNoTestsHTML(override.files));
    }
    res.writeHead(200, HTML_HEADERS);
    res.end(mainGroupHTML);
    saveHTML(
      path.join(path.resolve(groupConfig.projectRoot, groupConfig.output), 'index.html'),
      mainGroupHTML,
    );
  });

  server.get(`/group-${groupId}/tests.js`, (_req, res) => {
    const bytes = groupConfig.state.group.build.allTestCode?.length ?? null;
    if (bytes === null) {
      res.writeHead(503, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      return res.end(
        'console.error("[qunitx] /tests.js requested before bundle was built — allTestCode is null");',
      );
    }
    groupConfig.state.group.signals.onTestsJsServed?.();
    res.writeHead(200, {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-store',
      'Content-Length': bytes,
    });
    res.end(groupConfig.state.group.build.allTestCode);
  });

  // Group pages resolve the template's qunit.css link to /group-N/node_modules/qunitx/vendor/
  // qunit.css; serve the consumer's copy when installed, else the CLI's embedded one (see the
  // single-mode route in setupWebServer).
  server.get(`/group-${groupId}/node_modules/qunitx/vendor/qunit.css`, async (_req, res) => {
    const consumer = consumerQunitCssCandidate
      ? await fsPromise.readFile(consumerQunitCssCandidate).catch(() => null)
      : null;
    res.writeHead(200, { 'Content-Type': MIME_TYPES.css, 'Cache-Control': 'no-store' });
    res.end(consumer ?? (await readTemplate('vendor/qunit.css')));
  });
}

/**
 * Attaches the shared WebSocket event dispatcher to `server.wss`.
 * Routes each socket's messages to the correct group's `Config` using the `groupId`
 * baked into the browser-side `wsOpen` message by `testRuntimeToInject`.
 */
export function setupGroupWSHandler(server: HTTPServer, groupConfigs: Config[]): void {
  const socketToGroupId = new WeakMap<object, number>();
  // Diagnostic: count distinct WS connections seen by THIS shared-server handler
  // for each groupConfig. > 1 per group is suspicious in single-test runs;
  // see setupWebServer's wsConnectionCount comment for full rationale.
  for (const gc of groupConfigs) gc.state.group.wsConnectionCount = 0;

  server.wss.on('connection', function connection(socket) {
    socket.on('message', function message(data) {
      const { event, groupId, details, qunitResult, abort } = JSON.parse(data);

      let resolvedGroupId = socketToGroupId.get(socket);
      if (event === 'wsOpen' && typeof groupId === 'number') {
        resolvedGroupId = groupId;
        socketToGroupId.set(socket, groupId);
        const config = groupConfigs[resolvedGroupId];
        if (config) {
          config.state.group.wsConnectionCount = (config.state.group.wsConnectionCount ?? 0) + 1;
          if (config.state.group.wsConnectionCount > 1) {
            process.stderr.write(
              `# [qunitx][diag] group ${resolvedGroupId} accepted WS connection #${config.state.group.wsConnectionCount} — ` +
                `WS retry race in the injected runtime is the prime suspect.\n`,
            );
          }
        }
      }
      if (resolvedGroupId === undefined) return;
      const config = groupConfigs[resolvedGroupId];
      if (!config) return;

      if (event === 'wsOpen') {
        config.state.group.phase = 'loading';
        config.state.group.signals.onWsOpen?.();
      } else if (event === 'connection') {
        config.state.group.phase = 'running';
        // Dedup map reset owned by run.ts at groupConfig construction (see
        // setupWebServer for the equivalent rationale); not reset here.
        if (config.debug) debugGroupHeader(config);
        config.state.group.signals.resetTestTimeout?.();
      } else if (event === 'testEnd' && !abort) {
        // Server-side enforcement; see setupWebServer for full rationale.
        const fullName = details.fullName.join(' | ');
        const count = (config.state.group.testEndCounts?.get(fullName) ?? 0) + 1;
        config.state.group.testEndCounts?.set(fullName, count);
        if (count > 1) {
          diagWrite(
            `# [qunitx] WARNING: group ${resolvedGroupId} duplicate testEnd ignored for "${fullName}" — ` +
              `single-run testEnds should be unique.\n`,
          );
          return;
        }
        if (details.status === 'failed') {
          config.state.group.lastFailedFiles = config.state.group.ranFiles;
          recordFailedTest(config, details);
        }
        if (config.debug && details.runtime > config.timeout * 0.8) {
          process.stdout.write(
            `# SLOW (${details.runtime.toFixed(0)}ms / ${config.timeout}ms timeout): ${details.fullName.join(' | ')}\n`,
          );
        }
        config.state.group.signals.resetTestTimeout?.();
        reportTestEnd(config, details);
      } else if (event === 'done') {
        config.state.group.phase = 'done';
        config.state.group.lastQUnitResult = qunitResult ?? null;
        if (config.debug) {
          process.stdout.write(
            `# group done: ${details.passed} passed, ${details.failed} failed (${details.runtime}ms)\n`,
          );
        }
        if (typeof config.state.group.signals.testRunDone === 'function') {
          config.state.group.signals.testRunDone();
          config.state.group.signals.testRunDone = null;
        }
      }
    });
  });
}

/**
 * Registers a `GET /*` wildcard handler on a shared HTTPServer that serves static assets
 * from each group's output directory, routing by `/group-{id}/` URL prefix.
 */
export function registerSharedStaticHandler(server: HTTPServer, groupConfigs: Config[]): void {
  const groupUrlRegex = /^\/group-(\d+)(\/.*)?$/;

  server.get('/*', (req, res) => {
    const match = groupUrlRegex.exec(req.path);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const groupId = parseInt(match[1], 10);
    const groupConfig = groupConfigs[groupId];
    if (!groupConfig) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const STATIC_FILES_PATH = path.resolve(groupConfig.projectRoot, groupConfig.output);
    const subPath = match[2] || '/';
    const filePath = (
      subPath.endsWith('/')
        ? [STATIC_FILES_PATH, subPath, 'index.html']
        : [STATIC_FILES_PATH, subPath]
    ).join('');
    const contentType = req.headers.accept?.includes('text/html')
      ? MIME_TYPES.html
      : MIME_TYPES[path.extname(filePath).substring(1).toLowerCase()] || MIME_TYPES.html;
    const stream = fs.createReadStream(filePath);
    stream.on('open', () => {
      res.writeHead(200, { 'Content-Type': contentType });
      stream.pipe(res);
    });
    stream.on('error', () => {
      res.writeHead(404, { 'Content-Type': contentType });
      res.end(contentType === MIME_TYPES.html ? NOT_FOUND_HTML : undefined);
    });
  });
}

export { NOT_FOUND_HTML, setupWebServer as default };

// Candidate path to the consumer project's own qunit.css, so an installed qunitx takes precedence
// over the CLI's embedded copy (mirrors the esbuild runtime plugin's build.resolve-first behavior).
// Robust to npm workspaces / pnpm / npx layouts — all keep `/qunitx/` in the resolved entry path.
// Returns null when qunitx isn't installed; the caller reads the candidate non-blocking and falls
// back to the embedded css if it (or the file) is absent. `createRequire().resolve` is a one-time
// sync module lookup, not blocking file I/O.
function resolveConsumerQunitCssCandidate(projectRoot: string): string | null {
  try {
    const entry = createRequire(`${projectRoot}/package.json`).resolve('qunitx');
    const match = /^(.*[\\/]qunitx)[\\/]/.exec(entry);
    return match ? path.join(match[1], 'vendor/qunit.css') : null;
  } catch {
    return null;
  }
}

function replaceAssetPaths(html: string, htmlPath: string, projectRoot: string): string {
  const assetPaths = findInternalAssetsFromHTML(html);
  const htmlDirectory = htmlPath.split('/').slice(0, -1).join('/');

  return assetPaths.reduce((result, assetPath) => {
    const normalizedFullAbsolutePath = path.normalize(`${htmlDirectory}/${assetPath}`);

    return result.replace(assetPath, normalizedFullAbsolutePath.replace(projectRoot, '.'));
  }, html);
}

/**
 * Applies `file#34` line targets by pre-seeding `QUnit.config.testFilter`.
 *
 * QUnit merges `window.QUnit.config` into its own config at load time when the stub has no
 * `.version` (its "preconfig" path), then replaces `window.QUnit` with the real thing. This is
 * the channel for testFilter specifically: unlike `filter`/`module`, the html-reporter's
 * url-param block never overwrites it, so it also survives `--open`, where the saved file:// page
 * has whatever query it was opened with but the run itself is long over.
 *
 * A function is what makes exact selection possible — `filter` is a regex over a joined
 * "Module: test name" string, which cannot distinguish a module literally named `a: b`, and would
 * need every metacharacter in a user's test name escaped. QUnit ANDs testFilter after
 * filter/module, so -t/-m still compose.
 */
function qunitSelectorPreconfig(config: Config): string {
  if (!config.state.group.selectors?.length) {
    return '';
  }

  return `window.QUnit = { config: { testFilter: (function () {
      const selectors = ${JSON.stringify(config.state.group.selectors)};
      return function (testInfo) {
        return selectors.some(function (selector) {
          // No 'test' key means the target was a module: take it and everything nested under it.
          if (selector.test === undefined) {
            return testInfo.module === selector.module ||
              testInfo.module.indexOf(selector.module + ' > ') === 0;
          }
          return testInfo.module === selector.module && testInfo.testName === selector.test;
        });
      };
    })() } };`;
}

function testRuntimeToInject(config: Config, groupId?: number): string {
  const groupIdPart = groupId !== undefined ? `, groupId: ${groupId}` : '';
  return `<script>
    ${qunitSelectorPreconfig(config)}
    // Idempotency guard: if this runtime script ran in this Window already, do not
    // re-arm Promise.all + QUnit listeners. CI run 26046813154 (job 76573047617)
    // captured counter = 2 * expected with the diagnostic firing
    // "wss accepted connection #2" — TWO WS connections AND every test re-fired
    // testEnd. The only shape that produces both at once is the IIFE running
    // twice in one page: each invocation registers its own setupWebSocket and
    // its own QUnit.on('testEnd'), and QUnit then fires each event to BOTH
    // listeners. The trigger is rare (a sub-resource preload race observed on
    // Chromium + slow CI) but the consequence is a flaky pass count. Guarding
    // on a window-scoped sentinel is cheap and covers every reentry path
    // without needing to find the exact preload that caused it.
    if (window.__QUNITX_RUNTIME_INIT__) {
      console.log('# [qunitx][diag] runtime IIFE re-entry suppressed — already initialised in this Window');
    } else {
      window.__QUNITX_RUNTIME_INIT__ = true;
    (function() {
      // setupQUnit runs exactly once, after both the WebSocket is open and tests.js has loaded.
      // Promise.all is naturally idempotent — resolving a Promise a second time is a no-op,
      // so WebKit firing WS error after open (causing a retry that re-opens) cannot double-start.
      let resolveWsReady = () => {};
      const wsReadyPromise = window.location.protocol === 'file:'
        ? Promise.resolve()
        : new Promise(resolve => { resolveWsReady = resolve; });

      // { once: true } auto-removes the listener after the first fire.
      const testsReadyPromise = new Promise(resolve => {
        window.addEventListener('qunitx:tests-ready', resolve, { once: true });
      });

      Promise.all([wsReadyPromise, testsReadyPromise]).then(setupQUnit);

      // For static files (file:// protocol) there is no WebSocket server; wsReadyPromise
      // is already resolved above, so setupQUnit fires as soon as tests load.
      if (window.location.protocol === 'file:') return;

      const WS_MAX_RETRIES = Math.ceil(${config.timeout} / ${WS_RETRY_INTERVAL_MS}); // retry for the full test timeout window

      ${createReconnectingSocket.toString()}

      createReconnectingSocket({
        url: \`ws://localhost:\${location.port}\`,
        maxRetries: WS_MAX_RETRIES,
        retryIntervalMs: ${WS_RETRY_INTERVAL_MS},
        WebSocketCtor: WebSocket,
        setTimeoutFn: function (fn, ms) { window.setTimeout(fn, ms); },
        onSocket: function (socket) { window.socket = socket; },
        onOpen: function (socket) {
          resolveWsReady();
          // Notify Node.js that the WS socket is open. This fires immediately (< 1 s) because
          // this runtime script is tiny — tests.js background compilation hasn't finished yet.
          // Node.js uses this to distinguish "WS never connected" from "WS connected but bundle slow".
          if (navigator.webdriver) {
            socket.send(JSON.stringify({ event: 'wsOpen'${groupIdPart} }));
          }
        },
        onMessage: function (socket, messageEvent) {
          if (!navigator.webdriver && messageEvent.data === 'refresh') {
            window.location.reload(true);
          } else if (navigator.webdriver && messageEvent.data === 'abort') {
            window.abortQUnit = true;
            window.QUnit.config.queue.length = 0;
            socket.send(JSON.stringify({ event: 'abort' }));
          }
        },
        onExhausted: function () {
          console.log('WebSocket connection failed after ' + WS_MAX_RETRIES + ' retries');
        },
      }).connect();
    })();
    }

    function getCircularReplacer() {
      const ancestors = [];
      return function (key, value) {
        if (typeof value !== "object" || value === null) {
          return value;
        }
        while (ancestors.length > 0 && ancestors.at(-1) !== this) {
          ancestors.pop();
        }
        if (ancestors.includes(value)) {
          return "[Circular]";
        }
        ancestors.push(value);
        return value;
      };
    }

    function setupQUnit() {
      window.QUNIT_RESULT = { totalTests: 0, finishedTests: 0, failedTests: 0, currentTest: '' };

      // .version is what tells the real QUnit apart from the preconfig stub above: QUnit's own
      // preconfig detection keys off the same absence, and it only replaces window.QUnit once it
      // has loaded. Without the version check, a bundle that never imports qunitx would find the
      // stub here and blow up on QUnit.begin instead of reporting 0 tests.
      if (!window.QUnit || !window.QUnit.version) {
        console.log('QUnit not found after WebSocket connected');
        if (navigator.webdriver) {
          // Signal the Playwright runner that the run is complete with 0 tests rather than
          // waiting for the inactivity timeout. The runner treats totalTests === 0 as a
          // "no tests registered" warning (not a failure), so this gives a fast, clean result.
          window.QUNIT_RESULT = { totalTests: 0, finishedTests: 0, failedTests: 0, currentTest: null };
          window.socket.send(JSON.stringify({ event: 'done', details: { passed: 0, failed: 0, runtime: 0 } }));
        }
        return;
      }

      window.QUnit.begin(() => { // NOTE: might be useful in future for hanged module tracking
        if (navigator.webdriver) {
          window.socket.send(JSON.stringify({ event: 'connection' }));
        }
      });
      window.QUnit.on('testStart', (details) => {
        window.QUNIT_RESULT.totalTests++;
        window.QUNIT_RESULT.currentTest = details.fullName.join(' | ');
      });
      window.QUnit.on('testEnd', (details) => { // NOTE: https://github.com/qunitjs/qunit/blob/master/src/html-reporter/diff.js
        window.QUNIT_RESULT.finishedTests++;
        if (details.status === 'failed') window.QUNIT_RESULT.failedTests++;
        window.QUNIT_RESULT.currentTest = null;
        if (navigator.webdriver) {
          const isFailed = details.status === 'failed';
          const payload = isFailed ? details : { status: details.status, fullName: details.fullName, runtime: details.runtime };
          window.socket.send(JSON.stringify({ event: 'testEnd', details: payload, abort: window.abortQUnit }, isFailed ? getCircularReplacer() : undefined));

          if (${config.failFast} && details.status === 'failed') {
            window.QUnit.config.queue.length = 0;
          }
        }
      });
      window.QUnit.done((details) => {
        if (navigator.webdriver) {
          window.socket.send(JSON.stringify({ event: 'done', details: details, qunitResult: window.QUNIT_RESULT, abort: window.abortQUnit }, getCircularReplacer()));
        }
      });

      window.QUnit.config.testTimeout = ${config.timeout};
      // QUnit's failOnZeroTests synthesizes a "global failure" test when nothing matched. Under
      // a filter that is normal for most groups — only the group holding the match runs tests —
      // so leaving it on turns a working filter into N spurious failures. The aggregate
      // "nothing matched anywhere" check lives in run.ts, which can see every group.
      // Read in ProcessingQueue.done(), so setting it here (after declarations) is in time.
      window.QUnit.config.failOnZeroTests = ${!isFilteredRun(config)};
      window.QUnit.start();
    }
  </script>`;
}

function escapeAndInjectTestsToHTML(
  html: string,
  testRuntimeCode: string,
  testBundleUrl: string,
): string {
  // The test bundle is an external async script — Chrome compiles it in a background thread
  // so the WS 'open' event (fired by the tiny runtime above) is not blocked by compilation.
  // No need to escape </script> here: testRuntimeCode's closing tag is the legitimate script
  // closer, and user test code in tests.js is external (not inlined) so it can't break HTML.
  return injectScript(html, `${testRuntimeCode}\n<script src="${testBundleUrl}" async></script>`);
}

function debugGroupHeader(config: Config): void {
  const files = Object.keys(config.fsTree);
  const rel = files.map((f) => f.replace(`${config.projectRoot}/`, ''));
  const shown = rel.slice(0, 2);
  const rest = rel.length - shown.length;
  process.stdout.write(
    `# ${blue(`── ${shown.join('  ')}${rest > 0 ? `  +${rest} more` : ''} ──`)}\n`,
  );
}
