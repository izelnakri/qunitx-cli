import { blue } from '../utils/color.js';
import listenToKeyboardKey from '../utils/listen-to-keyboard-key.js';
import runTestsInBrowser from '../commands/run/tests-in-browser.js';

/**
 * Registers watch-mode keyboard shortcuts: `qq` to abort, `qa` to run all, `qf` for last failed, `ql` for last run.
 * @returns {void}
 */
export default function setupKeyboardEvents(config, cachedContent, connections) {
  listenToKeyboardKey('qq', () => abortBrowserQUnit(config, connections));
  listenToKeyboardKey('qa', () => {
    abortBrowserQUnit(config, connections);
    runTestsInBrowser(config, cachedContent, connections);
  });
  listenToKeyboardKey('qf', () => {
    abortBrowserQUnit(config, connections);

    if (!config.lastFailedTestFiles) {
      console.log('#', blue(`QUnitX: No tests failed so far, so repeating the last test run`));
      return runTestsInBrowser(config, cachedContent, connections, config.lastRanTestFiles);
    }

    runTestsInBrowser(config, cachedContent, connections, config.lastFailedTestFiles);
  });
  listenToKeyboardKey('ql', () => {
    abortBrowserQUnit(config, connections);
    runTestsInBrowser(config, cachedContent, connections, config.lastRanTestFiles);
  });
}

function abortBrowserQUnit(_config, connections) {
  connections.server.publish('abort', 'abort');
}
