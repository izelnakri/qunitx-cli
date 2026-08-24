import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { module, test } from 'qunitx';
import { exitOnSignal } from '../../lib/utils/exit-on-signal.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import '../helpers/custom-asserts.ts';

// Node's DEFAULT handling of a termination signal skips `process.on('exit')` handlers entirely.
// That is where a browser goes when CI stops a slow run: playwright kills it from one of those
// hooks, the hook never fires, and the browser is still there competing for the machine when the
// next run starts. On a Firefox-on-Windows lane that compounded until every test took four times
// its usual duration and the ones that fell off the end reported a 60s navigation timeout.
module('Utils | exitOnSignal', { concurrency: true }, () => {
  test('a signal becomes the conventional exit code for it', (assert) => {
    const exits: number[] = [];
    const handlers = new Map<string, () => void>();

    exitOnSignal({
      once: (signal, handler) => void handlers.set(signal, handler),
      exit: (code) => void exits.push(code),
    });

    handlers.get('SIGTERM')!();
    handlers.get('SIGINT')!();
    handlers.get('SIGHUP')!();

    assert.deepEqual(exits, [143, 130, 129], '128 + the signal number, for all three');
  });

  // Only a real process can answer this: whether the exit HOOKS run is not observable in-process.
  // Windows has no signals to send — `child.kill()` there is TerminateProcess, which is why the
  // test runner kills the whole tree instead. See spawnCapture's killTree.
  const signalled = process.platform === 'win32' ? test.skip : test;

  signalled('exit hooks still run when the process is signalled', async (assert) => {
    await using directory = await tempDir('exit-on-signal');
    const marker = path.join(directory.path, 'ran.txt');

    await signalAndWait('test/fixtures/signal-exit-hook.ts', marker);

    assert.strictEqual(
      await fs.readFile(marker, 'utf8').catch(() => null),
      'exit hook ran',
      'so playwright still gets to kill the browser it launched',
    );
  });

  signalled('without the wiring the hooks are skipped — the bug itself', async (assert) => {
    // The control. If this ever starts passing, Node changed its default and the wiring above is
    // no longer what is holding the guarantee up.
    await using directory = await tempDir('exit-on-signal-bare');
    const marker = path.join(directory.path, 'ran.txt');

    await signalAndWait('test/fixtures/signal-exit-hook.ts', marker, '--bare');

    assert.strictEqual(
      await fs.readFile(marker, 'utf8').catch(() => null),
      null,
      'default signal handling terminates without running exit hooks',
    );
  });
});

/** Starts the fixture, waits for it to say it is ready, SIGTERMs it, and waits for it to go. */
async function signalAndWait(script: string, ...args: string[]): Promise<void> {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));

  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
}
