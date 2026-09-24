import { spawn } from 'node:child_process';
import process from 'node:process';
import { module, test } from 'qunitx';
import { armExitGuard, type ExitTarget } from '../../lib/utils/exit-guard.ts';

// Exit 0 is the code Node gives a process that simply ran out of things to do, which makes every
// `await` a way to report success by accident. The guard turns that into the failure it is; these
// pin both halves — the code, and the sentence that makes the next one debuggable.

/** A `process` that can be exited on purpose: the listener it registers is kept to be fired. */
function fakeProcess(): {
  target: ExitTarget;
  exit: () => void;
  said: string[];
} {
  const listeners: Array<() => void> = [];
  const said: string[] = [];
  const target: ExitTarget = {
    exitCode: undefined,
    on: (_event, listener) => void listeners.push(listener as () => void),
  };

  return {
    target,
    exit: () => listeners.forEach((listener) => listener()),
    said,
  };
}

module('Utils | armExitGuard', { concurrency: true }, () => {
  test('the code is 1 from the moment it is armed, before anything is decided', (assert) => {
    const { target, said } = fakeProcess();

    armExitGuard(
      () => 'phase: connecting',
      target,
      (message) => said.push(message),
    );

    assert.strictEqual(target.exitCode, 1);
    assert.deepEqual(said, [], 'and nothing is said until something goes wrong');
  });

  test('a reported result decides the code and explains nothing', (assert) => {
    const { target, exit, said } = fakeProcess();
    const guard = armExitGuard(
      () => 'phase: running',
      target,
      (message) => said.push(message),
    );

    guard.reported(0);
    exit();

    assert.strictEqual(target.exitCode, 0, 'the run said 0, so it is 0');
    assert.deepEqual(said, [], 'a run that reported itself needs no diagnostic');
  });

  test('a reported failure keeps its own code', (assert) => {
    const { target, exit, said } = fakeProcess();
    const guard = armExitGuard(
      () => 'phase: running',
      target,
      (message) => said.push(message),
    );

    guard.reported(1);
    exit();

    assert.strictEqual(target.exitCode, 1);
    assert.deepEqual(said, []);
  });

  test('an exit nobody reported is a failure, and says where the run had got to', (assert) => {
    const { target, exit, said } = fakeProcess();
    armExitGuard(
      () => "phase 'loading', 3 results so far",
      target,
      (message) => said.push(message),
    );

    exit();

    assert.strictEqual(target.exitCode, 1);
    assert.strictEqual(said.length, 1);
    assert.true(said[0]!.includes('without reporting a result'), 'it names what happened');
    assert.true(said[0]!.includes("phase 'loading', 3 results so far"), 'and where it happened');
  });

  test('a 0 set by something else does not survive an unreported exit', (assert) => {
    const { target, exit, said } = fakeProcess();
    armExitGuard(
      () => 'phase: unknown',
      target,
      (message) => said.push(message),
    );

    // The shape this defends against: a success code set in passing (a drain callback, a
    // teardown, a library that thinks it is finishing) with the run's own result never in.
    target.exitCode = 0;
    exit();

    assert.strictEqual(target.exitCode, 1, 'the guard has the last word');
    assert.strictEqual(said.length, 1);
  });
});

// The unit tests above prove the bookkeeping; these prove the two facts it rests on, in a real
// process: that an armed exit code survives the loop going quiet, and that assigning one inside an
// `exit` listener still decides the status.
module('Utils | armExitGuard | in a real process', { concurrency: true }, () => {
  const GUARD = new URL('../../lib/utils/exit-guard.ts', import.meta.url).href;

  test('a process that runs out of work without reporting exits 1, and says so', async (assert) => {
    if ('Deno' in globalThis) {
      return assert.true(true, 'skipped under Deno — the node lane owns the `-e` child asserts');
    }
    const { code, stderr } = await runScript(
      `const { armExitGuard } = await import(${JSON.stringify(GUARD)});` +
        `armExitGuard(() => "phase 'connecting', 0 results so far");` +
        // Nothing keeps the loop alive, which is the whole failure: the process is about to end
        // having done nothing, and used to end saying everything was fine.
        `await Promise.resolve();`,
    );

    assert.strictEqual(code, 1, 'a run nobody heard the end of is not a passing run');
    assert.true(stderr.includes('exiting 1'), `stderr names the outcome, got: ${stderr}`);
    assert.true(stderr.includes("phase 'connecting'"), 'and carries the context');
  });

  test('a process that reports its result exits with it, silently', async (assert) => {
    if ('Deno' in globalThis) {
      return assert.true(true, 'skipped under Deno — the node lane owns the `-e` child asserts');
    }
    const { code, stderr } = await runScript(
      `const { armExitGuard } = await import(${JSON.stringify(GUARD)});` +
        `const guard = armExitGuard(() => 'phase: running');` +
        `guard.reported(0);`,
    );

    assert.strictEqual(code, 0);
    assert.strictEqual(stderr, '', 'nothing to explain about a run that ended properly');
  });
});

/** Runs a module script in a child node and resolves once every stdio stream has closed. */
function runScript(script: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));

  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stderr }));
  });
}
