import { module, test } from 'qunitx';
import process from 'node:process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';
import '../helpers/custom-asserts.ts';

const CWD = process.cwd();
const VERSION = JSON.parse(fs.readFileSync(`${CWD}/package.json`)).version;
const shell = promisify(exec);
const CLI_ENV = { ...process.env, FORCE_COLOR: '0' };
const cli = async function (arg = '') {
  if (process.argv[0].includes('deno')) {
    return await shell(`deno run --allow-read --allow-env ${CWD}/deno/cli.ts ${arg}`, {
      env: CLI_ENV,
    });
  }

  return await shell(`node --experimental-strip-types ${CWD}/cli.ts ${arg}`, { env: CLI_ENV });
};

const printedHelpOutput = `[qunitx v${VERSION}] Usage: qunitx [targets] --$flags

Input options:
- File: $ qunitx test/foo.js
- Folder: $ qunitx test/login
- Globs: $ qunitx test/**/*-test.js
- Combination: $ qunitx test/foo.js test/bar.js test/*-test.js test/logout

Optional flags:
--debug : print console output when tests run in browser
--watch : run the target file or folders, watch them for continuous run and expose http server under localhost
--open : run tests in a visible browser window instead of headless; keeps the server alive (short: -o)
--timeout : change default timeout per test case
--output : folder to distribute built qunitx html and js that a webservers can run[default: tmp]
--failFast : run the target file or folders with immediate abort if a single test fails
--port : HTTP server port (auto-selects a free port if the given port is taken)[default: 1234]
--extensions : comma-separated file extensions to track for discovery and watch-mode rebuilds[default: js,ts]
--browser : browser engine to run tests in: chromium, firefox, webkit[default: chromium]
--before : run a script before the tests(i.e start a new web server before tests)
--after : run a script after the tests(i.e save test results to a file)

Example: $ qunitx test/foo.ts app/e2e --debug --watch --before=scripts/start-new-webserver.js --after=scripts/write-test-results.js

Commands:
$ qunitx init               # Bootstraps qunitx base html and add qunitx config to package.json if needed
$ qunitx new $testFileName  # Creates a qunitx test file`;

module('Commands | Version tests', { concurrency: true }, () => {
  test('$ qunitx --version -> prints only the version number', async (assert) => {
    const { stdout } = await cli('--version');

    assert.strictEqual(stdout.trim(), VERSION);
  });

  test('$ qunitx -v -> prints only the version number', async (assert) => {
    const { stdout } = await cli('-v');

    assert.strictEqual(stdout.trim(), VERSION);
  });

  test('$ qunitx version -> prints only the version number', async (assert) => {
    const { stdout } = await cli('version');

    assert.strictEqual(stdout.trim(), VERSION);
  });
});

module('Commands | Help tests', { concurrency: true }, () => {
  test('$ qunitx -> prints help text', async (assert) => {
    const { stdout } = await cli();

    assert.includes(stdout, printedHelpOutput);
  });

  test('$ qunitx print -> prints help text', async (assert) => {
    const { stdout } = await cli('print');

    assert.includes(stdout, printedHelpOutput);
  });

  test('$ qunitx p -> prints help text', async (assert) => {
    const { stdout } = await cli('p');

    assert.includes(stdout, printedHelpOutput);
  });

  test('$ qunitx help -> prints help text', async (assert) => {
    const { stdout } = await cli('help');

    assert.includes(stdout, printedHelpOutput);
  });

  test('$ qunitx h -> prints help text', async (assert) => {
    const { stdout } = await cli('h');

    assert.includes(stdout, printedHelpOutput);
  });
});
