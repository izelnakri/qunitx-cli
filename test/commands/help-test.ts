import { module, test } from 'qunitx';
import process from 'node:process';
import fs from 'node:fs/promises';
import * as Help from '../../lib/commands/help.ts';
import { captureStdout } from '../helpers/capture-stdout.ts';
import { spawnCapture } from '../helpers/shell.ts';
import '../helpers/custom-asserts.ts';

const CWD = process.cwd();
const VERSION: string = JSON.parse(await fs.readFile(`${CWD}/package.json`, 'utf8')).version;

// lib/utils/color.ts decides ANSI on/off once at import time from env + TTY. Strip the codes
// rather than pin the environment, so the assertions below read the same either way. Built
// via fromCharCode because ESC in a regex literal is a lint error (no-control-regex).
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (text: string): string => text.replace(ANSI_SEQUENCE, '');

// Help.run() is synchronous console.log, so captureStdout (sync-only) sees all of it —
// no subprocess needed to assert on the usage text itself.
const helpText = (): string => stripAnsi(captureStdout(() => Help.run()));

// Spawned rather than `execute()`: the shell helper appends `--output=tmp/run-<uuid>` to
// every `node cli.ts …` command, which would make argv[2] non-empty and send the bare
// `$ qunitx` case down the run path instead of the help path.
const cli = (args: string): ReturnType<typeof spawnCapture> =>
  spawnCapture(`node cli.ts ${args}`.trim(), { env: { ...process.env, FORCE_COLOR: '0' } });

module('Commands | help | usage text', { concurrency: true }, () => {
  test('opens with the "[qunitx v<version>] Usage:" banner taken from package.json', (assert) => {
    assert.true(helpText().startsWith(`[qunitx v${VERSION}] Usage: qunitx [targets] --$flags`));
  });

  test('documents every input-target form', (assert) => {
    const text = helpText();
    for (const form of ['- File:', '- Folder:', '- Globs:', '- Combination:', '- Line target:']) {
      assert.includes(text, form);
    }
  });

  test('documents every optional flag the cli accepts', (assert) => {
    // The flag list is the cli's public contract — a flag added to lib/args without a line
    // here is undiscoverable, and a line here for a removed flag is a lie. Both directions
    // are caught by keeping this list in sync by hand when the parser changes.
    const text = helpText();
    const flags = [
      '--debug',
      '--watch',
      '--open',
      '--timeout',
      '--output',
      '--failFast',
      '--only-failed',
      '--filter',
      '--search',
      '--port',
      '--extensions',
      '--browser',
      '--reporter',
      '--junit',
      '--coverage',
      '--before',
      '--after',
      '--no-daemon',
      '--changed',
      '--since',
      '--trace-perf',
    ];
    for (const flag of flags) {
      assert.includes(text, `${flag} : `, `documents ${flag}`);
    }
  });

  test('documents the short and alias spellings alongside their long flags', (assert) => {
    const text = helpText();
    for (const spelling of [
      '--console',
      '-w',
      '-o',
      '-f',
      '--failed',
      '-t',
      '-m',
      '-n',
      '--module',
      '-s',
      '--print',
      '--preview',
      '-p',
      '-r',
    ]) {
      assert.includes(text, spelling, `documents ${spelling}`);
    }
  });

  test('documents the subcommands', (assert) => {
    const text = helpText();
    assert.includes(text, '$ qunitx init');
    assert.includes(text, '$ qunitx new $testFileName');
    assert.includes(text, '$ qunitx daemon <start|stop|status>');
  });

  test('documents the environment variables', (assert) => {
    const text = helpText();
    for (const variable of [
      'QUNITX_DAEMON=1',
      'QUNITX_NO_DAEMON=1',
      'QUNITX_BROWSER=...',
      'QUNITX_DEBUG=1',
    ]) {
      assert.includes(text, variable, `documents ${variable}`);
    }
  });
});

// End-to-end coverage of cli.ts's dispatch table — the one thing the in-process tests above
// cannot reach, since cli.ts runs its dispatch in a top-level IIFE with no exported seam.
module('Commands | help | cli dispatch', { concurrency: true }, () => {
  test('$ qunitx / print / p / help / h -> print usage and exit 0', async (assert) => {
    const banner = `[qunitx v${VERSION}] Usage: qunitx [targets] --$flags`;
    const results = await Promise.all(['', 'print', 'p', 'help', 'h'].map((arg) => cli(arg)));

    for (const [index, result] of results.entries()) {
      const spelling = ['<no args>', 'print', 'p', 'help', 'h'][index];
      assert.exitCode(result, 0, `qunitx ${spelling} exits 0`);
      assert.includes(result, banner, `qunitx ${spelling} prints usage`);
    }
  });
});

module('Commands | version', { concurrency: true }, () => {
  test('$ qunitx --version / -v / version -> print only the version number', async (assert) => {
    const results = await Promise.all(['--version', '-v', 'version'].map((arg) => cli(arg)));

    for (const [index, result] of results.entries()) {
      const spelling = ['--version', '-v', 'version'][index];
      assert.exitCode(result, 0, `qunitx ${spelling} exits 0`);
      assert.strictEqual(result.stdout.trim(), VERSION, `qunitx ${spelling} prints the version`);
    }
  });
});
