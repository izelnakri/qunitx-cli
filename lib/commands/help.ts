import { blue, magenta } from '../utils/color.ts';
import pkg from '../../package.json' with { type: 'json' };

const highlight = (text) => magenta().bold(text);
const color = (text) => blue(text);

/** Prints qunitx-cli usage information to stdout. */
export function displayHelpOutput() {
  const config = pkg;

  console.log(`${highlight('[qunitx v' + config.version + '] Usage:')} qunitx ${color('[targets] --$flags')}

${highlight('Input options:')}
- File: $ ${color('qunitx test/foo.js')}
- Folder: $ ${color('qunitx test/login')}
- Globs: $ ${color('qunitx test/**/*-test.js')}
- Combination: $ ${color('qunitx test/foo.js test/bar.js test/*-test.js test/logout')}

${highlight('Optional flags:')}
${color('--debug')} : print console output when tests run in browser
${color('--watch')} : run the target file or folders, watch them for continuous run and expose http server under localhost
${color('--open')} : run tests in a visible browser window instead of headless; keeps the server alive (short: ${color('-o')})
${color('--timeout')} : change default timeout per test case
${color('--output')} : folder to distribute built qunitx html and js that a webservers can run[default: tmp]
${color('--failFast')} : run the target file or folders with immediate abort if a single test fails
${color('--port')} : HTTP server port (auto-selects a free port if the given port is taken)[default: 1234]
${color('--extensions')} : comma-separated file extensions to track for discovery and watch-mode rebuilds[default: js,ts,jsx,tsx]
${color('--browser')} : browser engine to run tests in: chromium, firefox, webkit[default: chromium]
${color('--before')} : run a script before the tests(i.e start a new web server before tests)
${color('--after')} : run a script after the tests(i.e save test results to a file)
${color('--no-daemon')} : don't use the daemon for this run — skips a running daemon and prevents ${color('QUNITX_DAEMON')} auto-spawn

${highlight('Example:')} $ ${color('qunitx test/foo.ts app/e2e --debug --watch --before=scripts/start-new-webserver.js --after=scripts/write-test-results.js')}

${highlight('Commands:')}
${color('$ qunitx init')}                            # Bootstraps qunitx base html and add qunitx config to package.json if needed
${color('$ qunitx new $testFileName')}               # Creates a qunitx test file
${color('$ qunitx daemon <start|stop|status>')}      # Optional persistent daemon — ~2× faster repeated runs

${highlight('Environment:')}
${color('QUNITX_DAEMON=1')}     : auto-spawn the daemon on the first qunitx run; reuse it on every run after (overrides the CI=1 bypass)
${color('QUNITX_NO_DAEMON=1')}  : never use the daemon for this run
`);
}

export { displayHelpOutput as default };
