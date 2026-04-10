import fs from 'node:fs';
import path from 'node:path';
import findInternalAssetsFromHTML from '../utils/find-internal-assets-from-html.ts';
import { replaceHTMLContentMarker } from '../utils/html-content-marker.ts';
import TAPDisplayTestResult from '../tap/display-test-result.ts';
import pathExists from '../utils/path-exists.ts';
import HTTPServer, { MIME_TYPES } from '../servers/http.ts';
import type { Config, CachedContent } from '../types.ts';

const fsPromise = fs.promises;

/**
 * Creates and returns an HTTPServer with routes for the test HTML, filtered test page, and static assets, plus a WebSocket handler that streams TAP events.
 * @returns {object}
 */
export default function setupWebServer(config: Config, cachedContent: CachedContent): HTTPServer {
  const STATIC_FILES_PATH = path.join(config.projectRoot, config.output);
  const server = new HTTPServer();
  const mainHTMLWithReplacedAssets = replaceAssetPaths(
    cachedContent.mainHTML.html,
    cachedContent.mainHTML.filePath,
    config.projectRoot,
  );

  server.wss.on('connection', function connection(socket) {
    socket.on('message', function message(data) {
      const { event, details, abort } = JSON.parse(data);

      if (event === 'wsOpen') {
        // WebSocket socket opened — test bundle is still compiling in the background.
        // Signal Node.js so it can flip wsConnected for accurate TIMEOUT diagnostics
        // without resetting the per-test timer (that happens on 'connection' below).
        config._onWsOpen?.();
      } else if (event === 'connection') {
        if (!config._groupMode) console.log('TAP version 13');
        config._resetTestTimeout?.();
      } else if (event === 'testEnd' && !abort) {
        if (details.status === 'failed') {
          config.lastFailedTestFiles = config.lastRanTestFiles;
        }

        config._resetTestTimeout?.();
        TAPDisplayTestResult(config.COUNTER, details);
      } else if (event === 'done') {
        // Signal test completion. TCP ordering guarantees all testEnd messages
        // preceding this on the same connection are already processed by Node.js.
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
  server.get('/tests.js', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
    res.end(cachedContent.allTestCode);
  });

  server.get('/filtered-tests.js', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
    res.end(cachedContent.filteredTestCode);
  });

  server.get('/', async (_req, res) => {
    const TEST_RUNTIME_TO_INJECT = testRuntimeToInject(config.port, config);
    const htmlContent = escapeAndInjectTestsToHTML(
      mainHTMLWithReplacedAssets,
      TEST_RUNTIME_TO_INJECT,
      './tests.js',
    );

    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.write(htmlContent);
    res.end();

    return await fsPromise.writeFile(
      `${config.projectRoot}/${config.output}/index.html`,
      htmlContent,
    );
  });

  server.get('/qunitx.html', async (_req, res) => {
    const TEST_RUNTIME_TO_INJECT = testRuntimeToInject(config.port, config);
    const htmlContent = escapeAndInjectTestsToHTML(
      mainHTMLWithReplacedAssets,
      TEST_RUNTIME_TO_INJECT,
      './filtered-tests.js',
    );

    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.write(htmlContent);
    res.end();

    return await fsPromise.writeFile(
      `${config.projectRoot}/${config.output}/qunitx.html`,
      htmlContent,
    );
  });

  server.get('/*', async (req, res) => {
    const possibleDynamicHTML =
      cachedContent.dynamicContentHTMLs[`${config.projectRoot}${req.path}`];
    if (possibleDynamicHTML) {
      const TEST_RUNTIME_TO_INJECT = testRuntimeToInject(config.port, config);
      const htmlContent = escapeAndInjectTestsToHTML(
        possibleDynamicHTML,
        TEST_RUNTIME_TO_INJECT,
        '/tests.js',
      );

      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.write(htmlContent);
      res.end();

      return await fsPromise.writeFile(
        `${config.projectRoot}/${config.output}${req.path}`,
        htmlContent,
      );
    }

    const url = req.url;
    const requestStartedAt = new Date();
    const filePath = (
      url.endsWith('/') ? [STATIC_FILES_PATH, url, 'index.html'] : [STATIC_FILES_PATH, url]
    ).join('');
    const statusCode = (await pathExists(filePath)) ? 200 : 404;

    res.writeHead(statusCode, {
      'Content-Type': req.headers.accept?.includes('text/html')
        ? MIME_TYPES.html
        : MIME_TYPES[path.extname(filePath).substring(1).toLowerCase()] || MIME_TYPES.html,
    });

    if (statusCode === 404) {
      res.end();
    } else {
      fs.createReadStream(filePath).pipe(res);
    }

    console.log(`# [HTTPServer] GET ${url} ${statusCode} - ${new Date() - requestStartedAt}ms`);
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

function testRuntimeToInject(port: number, config: Config): string {
  return `<script>
    window.testTimeout = 0;
    setInterval(() => {
      window.testTimeout = window.testTimeout + 1000;
    }, 1000);

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
          window.socket = new WebSocket('ws://localhost:${port}');
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
          if (window.IS_PLAYWRIGHT) {
            window.socket.send(JSON.stringify({ event: 'wsOpen' }));
          }
          maybeStart();
        });
        window.socket.addEventListener('error', function() {
          retryOrFail();
        });
        window.socket.addEventListener('message', function(messageEvent) {
          if (!window.IS_PLAYWRIGHT && messageEvent.data === 'refresh') {
            window.location.reload(true);
          } else if (window.IS_PLAYWRIGHT && messageEvent.data === 'abort') {
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
          window.testTimeout = ${config.timeout};
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
        window.testTimeout = ${config.timeout};
        return;
      }

      window.QUnit.begin(() => { // NOTE: might be useful in future for hanged module tracking
        if (window.IS_PLAYWRIGHT) {
          window.socket.send(JSON.stringify({ event: 'connection' }));
        }
      });
      window.QUnit.moduleStart((details) => { // NOTE: might be useful in future for hanged module tracking
        if (window.IS_PLAYWRIGHT) {
          window.socket.send(JSON.stringify({ event: 'moduleStart', details: details }, getCircularReplacer()));
        }
      });
      window.QUnit.on('testStart', (details) => {
        window.QUNIT_RESULT.totalTests++;
        window.QUNIT_RESULT.currentTest = details.fullName.join(' | ');
      });
      window.QUnit.on('testEnd', (details) => { // NOTE: https://github.com/qunitjs/qunit/blob/master/src/html-reporter/diff.js
        window.testTimeout = 0;
        window.QUNIT_RESULT.finishedTests++;
        if (details.status === 'failed') window.QUNIT_RESULT.failedTests++;
        window.QUNIT_RESULT.currentTest = null;
        if (window.IS_PLAYWRIGHT) {
          window.socket.send(JSON.stringify({ event: 'testEnd', details: details, abort: window.abortQUnit }, getCircularReplacer()));

          if (${config.failFast} && details.status === 'failed') {
            window.QUnit.config.queue.length = 0;
          }
        }
      });
      window.QUnit.done((details) => {
        if (window.IS_PLAYWRIGHT) {
          window.socket.send(JSON.stringify({ event: 'done', details: details, abort: window.abortQUnit }, getCircularReplacer()));
          // Do NOT set testTimeout here. The WS 'done' event (testsDone promise) is the
          // canonical completion signal for Playwright runs. waitForFunction is reserved
          // for true timeouts (test hangs) where testTimeout increments naturally via setInterval.
          // Setting testTimeout after done caused a race: under CI load, waitForFunction could
          // win before Node.js processed the WS done message, dropping all testEnd events.
        } else {
          window.testTimeout = ${config.timeout};
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
  return replaceHTMLContentMarker(
    html,
    `${testRuntimeCode}\n<script src="${testBundleUrl}" async></script>`,
  );
}
