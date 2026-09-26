import process from 'node:process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { module, test } from 'qunitx';
import { shellWatch } from '../helpers/shell.ts';
import '../helpers/custom-asserts.ts';

// A long-running command stopped by a signal must EXIT, not die of it: only an exit runs the
// `process.on('exit')` hooks that take the pre-launched Chrome down (see exit-on-signal-test.ts
// for that half). Dying of it leaves the browser running. The harness stops children with
// SIGTERM unless told otherwise, which --watch has always handled, so SIGINT from `kill -INT`, a process manager or a
// supervisor, and SIGHUP from a closed terminal, went unnoticed — as did every signal to `repl`
// and `run`.
// Windows has no signals to send; child.kill() there is TerminateProcess.
const signalled = process.platform === 'win32' ? test.skip : test;
// Deno's `node:child_process` cannot tell a HANDLED signal from a fatal one. The same compiled
// binary reports `exit=143 signal=null` to a node parent and `code=null signal=SIGTERM` to a deno
// one — measured both ways, for all three signals — so under the deno runner the codes below are
// the shim's answer rather than the child's. What is still observable there is that the signal
// stopped it at all, which is asserted instead; the node lane runs the same commands and keeps
// the exact codes, and `exit-on-signal-test.ts` unit-tests the mapping with no child at all.
const RUNNER_IS_DENO = typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined';
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

      const output = await shellWatch(command, {
        onSpawn: (spawned) => (child = spawned),
        until: (buffer) => buffer.includes(ready),
        stopWith: signal,
      });

      // `shellWatch` throws if the child had to be SIGKILLed, so reaching here is already the
      // claim that `${signal}` alone stopped it within the grace.
      assert.includes(output, ready, `it was up before ${signal}`);
      if (RUNNER_IS_DENO) return;

      assert.strictEqual(child!.signalCode, null, `not killed by ${signal}`);
      assert.strictEqual(child!.exitCode, code, `128 + the number of ${signal}`);
    });
  }
});
