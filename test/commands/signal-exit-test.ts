import process from 'node:process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { module, test } from 'qunitx';
import { shellWatch } from '../helpers/shell.ts';

// A long-running command stopped by a signal must EXIT, not die of it: only an exit runs the
// `process.on('exit')` hooks that take the pre-launched Chrome down (see exit-on-signal-test.ts
// for that half). Dying of it leaves the browser running. The harness stops children with
// SIGTERM unless told otherwise, which --watch has always handled, so SIGINT from `kill -INT`, a process manager or a
// supervisor, and SIGHUP from a closed terminal, went unnoticed — as did every signal to `repl`
// and `run`.
// Windows has no signals to send; child.kill() there is TerminateProcess.
const signalled = process.platform === 'win32' ? test.skip : test;
const WATCH: [string, string, string] = [
  '--watch',
  'node cli.ts test/fixtures/passing-tests.ts --watch',
  'Press "qq"',
];
const REPL: [string, string, string] = ['repl', 'node cli.ts repl', 'type `.help`'];
const RUN: [string, string, string] = [
  'run --watch',
  'node cli.ts run test/fixtures/scripts/browser-script.ts --watch',
  '# Watching',
];
const CASES: [[name: string, command: string, ready: string], NodeJS.Signals, number][] = [
  [WATCH, 'SIGINT', 130],
  [WATCH, 'SIGHUP', 129],
  [REPL, 'SIGINT', 130],
  [REPL, 'SIGTERM', 143],
  [REPL, 'SIGHUP', 129],
  [RUN, 'SIGINT', 130],
  [RUN, 'SIGTERM', 143],
];

module('Commands | a signal is an exit', { concurrency: true }, () => {
  for (const [[name, command, ready], signal, code] of CASES) {
    signalled(`${name} exits ${code} on ${signal}`, async (assert) => {
      let child: ChildProcessWithoutNullStreams | null = null;

      await shellWatch(command, {
        onSpawn: (spawned) => (child = spawned),
        until: (buffer) => buffer.includes(ready),
        stopWith: signal,
      });

      assert.strictEqual(child!.signalCode, null, `not killed by ${signal}`);
      assert.strictEqual(child!.exitCode, code, `128 + the number of ${signal}`);
    });
  }
});
