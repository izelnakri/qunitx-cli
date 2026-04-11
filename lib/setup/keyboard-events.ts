import { blue } from '../utils/color.ts';
import listenToKeyboardKey from '../utils/listen-to-keyboard-key.ts';
import runTestsInBrowser from '../commands/run/tests-in-browser.ts';
import type { Config, CachedContent, Connections } from '../types.ts';

/**
 * Registers watch-mode keyboard shortcuts: `qq` to abort, `qa` to run all, `qf` for last failed, `ql` for last run.
 * @returns {void}
 */
export default function setupKeyboardEvents(
  config: Config,
  cachedContent: CachedContent,
  connections: Connections,
): void {
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

function abortBrowserQUnit(_config: Config, connections: Connections): void {
  connections.server.publish('abort');
}
