import fs from 'node:fs';
import path from 'node:path';
import { findInternalAssetsFromHTML } from '../utils/find-internal-assets-from-html.ts';
import { injectScript } from '../utils/html.ts';
import { TAPDisplayTestResult } from '../tap/display-test-result.ts';
import { blue } from '../utils/color.ts';
import { HTTPServer, MIME_TYPES } from '../servers/http.ts';
import type { Config, CachedContent } from '../types.ts';

const fsPromise = fs.promises;

const HTML_HEADERS = { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } as const;

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
export function setupWebServer(config: Config, cachedContent: CachedContent): HTTPServer {
  const STATIC_FILES_PATH = path.join(config.projectRoot, config.output);
  const server = new HTTPServer();
  const mainHTMLWithReplacedAssets = replaceAssetPaths(
    cachedContent.mainHTML.html,
    cachedContent.mainHTML.filePath,
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

  server.wss.on('connection', function connection(socket) {
    socket.on('message', function message(data) {
      const { event, details, qunitResult, abort } = JSON.parse(data);

      if (event === 'wsOpen') {
        // WebSocket socket opened — test bundle is still compiling in the background.
        // Signal Node.js so it can flip wsConnected for accurate TIMEOUT diagnostics
        // without resetting the per-test timer (that happens on 'connection' below).
        config._phase = 'loading';
        config._onWsOpen?.();
      } else if (event === 'connection') {
        config._phase = 'running';
        if (!config._groupMode) process.stdout.write('TAP version 13\n');
        if (config.debug && config._groupMode) debugGroupHeader(config);
        config._resetTestTimeout?.();
      } else if (event === 'testEnd' && !abort) {
        if (details.status === 'failed') {
          config.lastFailedTestFiles = config.lastRanTestFiles;
        }

        if (config.debug && details.runtime > config.timeout * 0.8) {
          process.stdout.write(
            `# SLOW (${details.runtime.toFixed(0)}ms / ${config.timeout}ms timeout): ${details.fullName.join(' | ')}\n`,
          );
        }
        config._resetTestTimeout?.();
        TAPDisplayTestResult(config.COUNTER, details);
      } else if (event === 'done') {
        // Signal test completion. TCP ordering guarantees all testEnd messages
        // preceding this on the same connection are already processed by Node.js.
        config._phase = 'done';
        // Store the browser-side QUNIT_RESULT so runTestInsideHTMLFile can read it
        // without a page.evaluate() CDP round-trip after testRaceResult resolves.
        config._lastQUnitResult = qunitResult ?? null;
        if (config.debug && config._groupMode) {
          process.stdout.write(
            `# group done: ${details.passed} passed, ${details.failed} failed (${details.runtime}ms)\n`,
          );
        }
        if (typeof config._testRunDone === 'function') {
          config._testRunDone();
          config._testRunDone = null;
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
        config._lastQUnitResult = {
          totalTests: 0,
          finishedTests: 0,
          failedTests: 0,
          currentTest: null,
        };
        config._testRunDone?.();
        config._testRunDone = null;
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
    config._onTestsJsServed?.();
    res.writeHead(200, {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-store',
      'Content-Length': bytes,
    });
    res.end(cachedContent.allTestCode);
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
    config._onTestsJsServed?.();
    res.writeHead(200, {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-store',
      'Content-Length': bytes,
    });
    res.end(cachedContent.filteredTestCode);
  });

  server.get('/', async (_req, res) => {
    // buildTestBundle clears _buildError only after its first await (fs.mkdir), so a stale
    // error from the previous run can persist into the next run's navigation window.
    // Awaiting _activeRebuild here ensures we act on the settled build state, not stale state.
    await cachedContent._activeRebuild?.catch(() => {});
    if (cachedContent._buildError) {
      const htmlContent = buildErrorHTML(cachedContent._buildError);
      res.writeHead(200, HTML_HEADERS);
      res.end(htmlContent);
      // Build error HTML has no tests.js script tag, so the /tests.js route never fires.
      // Resolve testRaceResult from Node.js directly when a parallel build was in-flight.
      if (cachedContent._activeRebuild) {
        config._lastQUnitResult = {
          totalTests: 0,
          finishedTests: 0,
          failedTests: 0,
          currentTest: null,
        };
        config._testRunDone?.();
        config._testRunDone = null;
      }
      return saveHTML(`${config.projectRoot}/${config.output}/index.html`, htmlContent);
    }
    if (cachedContent._noTestsWarning) {
      res.writeHead(200, HTML_HEADERS);
      return res.end(buildNoTestsHTML(cachedContent._noTestsWarning));
    }
    res.writeHead(200, HTML_HEADERS);
    res.end(mainIndexHTML);
    saveHTML(`${config.projectRoot}/${config.output}/index.html`, mainIndexHTML);
  });

  server.get('/qunitx.html', (_req, res) => {
    if (cachedContent._buildError) {
      const htmlContent = buildErrorHTML(cachedContent._buildError);
      res.writeHead(200, HTML_HEADERS);
      res.end(htmlContent);
      return saveHTML(`${config.projectRoot}/${config.output}/qunitx.html`, htmlContent);
    }
    if (cachedContent._noTestsWarning) {
      res.writeHead(200, HTML_HEADERS);
      return res.end(buildNoTestsHTML(cachedContent._noTestsWarning));
    }
    res.writeHead(200, HTML_HEADERS);
    res.end(mainQunitxHTML);
    saveHTML(`${config.projectRoot}/${config.output}/qunitx.html`, mainQunitxHTML);
  });

  server.get('/*', (req, res) => {
    const possibleDynamicHTML =
      cachedContent.dynamicContentHTMLs[`${config.projectRoot}${req.path}`];
    if (possibleDynamicHTML) {
      const htmlContent = escapeAndInjectTestsToHTML(
        possibleDynamicHTML,
        runtimeScript,
        '/tests.js',
      );
      res.writeHead(200, HTML_HEADERS);
      res.end(htmlContent);
      saveHTML(`${config.projectRoot}/${config.output}${req.path}`, htmlContent);
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

function replaceAssetPaths(html: string, htmlPath: string, projectRoot: string): string {
  const assetPaths = findInternalAssetsFromHTML(html);
  const htmlDirectory = htmlPath.split('/').slice(0, -1).join('/');

  return assetPaths.reduce((result, assetPath) => {
    const normalizedFullAbsolutePath = path.normalize(`${htmlDirectory}/${assetPath}`);

    return result.replace(assetPath, normalizedFullAbsolutePath.replace(projectRoot, '.'));
  }, html);
}

function testRuntimeToInject(config: Config, groupId?: number): string {
  const groupIdPart = groupId !== undefined ? `, groupId: ${groupId}` : '';
  return `<script>
    (function() {
      // wsOpenStatus: true once the WebSocket 'open' event fires (or immediately for static files).
      // testsLoaded: true once tests.js has executed and dispatched 'qunitx:tests-ready'.
      // Both must be true before setupQUnit() is called, ensuring QUnit.start() only runs
      // after all test modules are registered.
      let wsOpenStatus = window.location.protocol === 'file:';
      let testsLoaded = false;

      function maybeStart() {
        if (wsOpenStatus && testsLoaded) setupQUnit();
      }

      // tests.js (loaded as an async external script) dispatches this event after registering
      // all test modules. Decoupled from WS so Chrome can compile tests.js in a background
      // thread while the main thread handles the WebSocket handshake.
      window.addEventListener('qunitx:tests-ready', function() {
        testsLoaded = true;
        maybeStart();
      });

      // For static files (file:// protocol) there is no WebSocket server.
      // wsOpenStatus is already true above; setupQUnit fires when tests load.
      if (window.location.protocol === 'file:') return;

      let wsRetryCount = 0;
      const WS_MAX_RETRIES = Math.ceil(${config.timeout} / 10); // retry for the full test timeout window

      function setupWebSocket() {
        try {
          window.socket = new WebSocket(\`ws://localhost:\${location.port}\`);
        } catch (error) {
          console.log(error);
          retryOrFail();
          return;
        }

        window.socket.addEventListener('open', function() {
          wsOpenStatus = true;
          // Notify Node.js that the WS socket is open. This fires immediately (< 1 s) because
          // this runtime script is tiny — tests.js background compilation hasn't finished yet.
          // Node.js uses this to distinguish "WS never connected" from "WS connected but bundle slow".
          if (navigator.webdriver) {
            window.socket.send(JSON.stringify({ event: 'wsOpen'${groupIdPart} }));
          }
          maybeStart();
        });
        window.socket.addEventListener('error', function() {
          retryOrFail();
        });
        window.socket.addEventListener('message', function(messageEvent) {
          if (!navigator.webdriver && messageEvent.data === 'refresh') {
            window.location.reload(true);
          } else if (navigator.webdriver && messageEvent.data === 'abort') {
            window.abortQUnit = true;
            window.QUnit.config.queue.length = 0;
            window.socket.send(JSON.stringify({ event: 'abort' }));
          }
        });
      }

      function retryOrFail() {
        wsRetryCount++;
        if (wsRetryCount > WS_MAX_RETRIES) {
          console.log('WebSocket connection failed after ' + WS_MAX_RETRIES + ' retries');
          return;
        }
        window.setTimeout(setupWebSocket, 10);
      }

      setupWebSocket();
    })();

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

      if (!window.QUnit) {
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
          ws.addEventListener('message', function (e) { if (e.data === 'refresh') location.reload(true); });
          ws.addEventListener('close', function () { if (retries++ < 120) setTimeout(connect, 1000); });
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
          ws.addEventListener('message', function (e) { if (e.data === 'refresh') location.reload(true); });
          ws.addEventListener('close', function () { if (retries++ < 120) setTimeout(connect, 1000); });
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
export function registerGroupRoutes(
  server: HTTPServer,
  groupConfig: Config,
  groupCachedContent: CachedContent,
  groupId: number,
): void {
  const mainHTMLWithReplacedAssets = replaceAssetPaths(
    groupCachedContent.mainHTML.html!,
    groupCachedContent.mainHTML.filePath!,
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
    if (groupCachedContent._buildError) {
      res.writeHead(200, HTML_HEADERS);
      return res.end(buildErrorHTML(groupCachedContent._buildError));
    }
    if (groupCachedContent._noTestsWarning) {
      res.writeHead(200, HTML_HEADERS);
      return res.end(buildNoTestsHTML(groupCachedContent._noTestsWarning));
    }
    res.writeHead(200, HTML_HEADERS);
    res.end(mainGroupHTML);
    saveHTML(`${groupConfig.projectRoot}/${groupConfig.output}/index.html`, mainGroupHTML);
  });

  server.get(`/group-${groupId}/tests.js`, (_req, res) => {
    const bytes = groupCachedContent.allTestCode?.length ?? null;
    if (bytes === null) {
      res.writeHead(503, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      return res.end(
        'console.error("[qunitx] /tests.js requested before bundle was built — allTestCode is null");',
      );
    }
    groupConfig._onTestsJsServed?.();
    res.writeHead(200, {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-store',
      'Content-Length': bytes,
    });
    res.end(groupCachedContent.allTestCode);
  });
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

/**
 * Attaches the shared WebSocket event dispatcher to `server.wss`.
 * Routes each socket's messages to the correct group's `Config` using the `groupId`
 * baked into the browser-side `wsOpen` message by `testRuntimeToInject`.
 */
export function setupGroupWSHandler(server: HTTPServer, groupConfigs: Config[]): void {
  const socketToGroupId = new WeakMap<object, number>();

  server.wss.on('connection', function connection(socket) {
    socket.on('message', function message(data) {
      const { event, groupId, details, qunitResult, abort } = JSON.parse(data);

      let resolvedGroupId = socketToGroupId.get(socket);
      if (event === 'wsOpen' && typeof groupId === 'number') {
        resolvedGroupId = groupId;
        socketToGroupId.set(socket, groupId);
      }
      if (resolvedGroupId === undefined) return;
      const config = groupConfigs[resolvedGroupId];
      if (!config) return;

      if (event === 'wsOpen') {
        config._phase = 'loading';
        config._onWsOpen?.();
      } else if (event === 'connection') {
        config._phase = 'running';
        if (config.debug) debugGroupHeader(config);
        config._resetTestTimeout?.();
      } else if (event === 'testEnd' && !abort) {
        if (details.status === 'failed') {
          config.lastFailedTestFiles = config.lastRanTestFiles;
        }
        if (config.debug && details.runtime > config.timeout * 0.8) {
          process.stdout.write(
            `# SLOW (${details.runtime.toFixed(0)}ms / ${config.timeout}ms timeout): ${details.fullName.join(' | ')}\n`,
          );
        }
        config._resetTestTimeout?.();
        TAPDisplayTestResult(config.COUNTER, details);
      } else if (event === 'done') {
        config._phase = 'done';
        config._lastQUnitResult = qunitResult ?? null;
        if (config.debug) {
          process.stdout.write(
            `# group done: ${details.passed} passed, ${details.failed} failed (${details.runtime}ms)\n`,
          );
        }
        if (typeof config._testRunDone === 'function') {
          config._testRunDone();
          config._testRunDone = null;
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

    const STATIC_FILES_PATH = path.join(groupConfig.projectRoot, groupConfig.output);
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
