import { spawn } from 'node:child_process';
import process from 'node:process';
import { module, test } from 'qunitx';
import { withLoopAlive } from '../../lib/utils/with-loop-alive.ts';

module('Utils | withLoopAlive', { concurrency: true }, () => {
  test('hands back what the work returned', async (assert) => {
    assert.strictEqual(await withLoopAlive(() => Promise.resolve(7)), 7);
  });

  test('a rejection is still a rejection', async (assert) => {
    const failure = await withLoopAlive(() => Promise.reject(new Error('gone'))).catch(
      (error: Error) => error.message,
    );

    assert.strictEqual(failure, 'gone');
  });

  test('the timer is cleared either way, so it cannot outlive the work', async (assert) => {
    // Proven by the process rather than by the handle: a child that finishes work and then has
    // nothing left must exit on its own. An interval the `finally` failed to clear would keep it
    // running until something killed it — which is the bug this utility could become.
    if ('Deno' in globalThis) {
      return assert.true(true, 'skipped under Deno — the node lane owns the `-e` child asserts');
    }
    const [resolved, rejected] = await Promise.all([
      runScript(`await withLoopAlive(() => Promise.resolve('done'));`),
      runScript(`await withLoopAlive(() => Promise.reject(new Error('x'))).catch(() => {});`),
    ]);

    assert.strictEqual(resolved.code, 0, 'exits once the work is done');
    assert.strictEqual(rejected.code, 0, 'and once it has failed');
  });
});

// The reason the utility exists, as the two processes it tells apart. This is the CI failure in
// miniature: a run waiting on something that never comes, in a process with no handles left.
module('Utils | withLoopAlive | a wait that never comes back', { concurrency: true }, () => {
  test('ends the process silently without it, and cannot end it with it', async (assert) => {
    if ('Deno' in globalThis) {
      return assert.true(true, 'skipped under Deno — the node lane owns the `-e` child asserts');
    }
    // Both children wait inside a floating async function rather than at the top level, because
    // that is the shape cli.ts has — and it is the shape with no safety net. Node exits 13 for an
    // unfinished TOP-LEVEL await; a promise nobody is awaiting from the module body just lets the
    // loop go quiet, and a quiet loop exits 0.
    //
    // Unguarded: Node has nothing left to do, so it exits — reporting 0 for work that never
    // finished. Windows CI run 35946105100 is this, with a browser in place of the bare promise.
    const unguarded = await runScript(`void (async () => { await new Promise(() => {}); })();`);

    assert.strictEqual(unguarded.code, 0, 'the failure shape: a clean exit out of a dead wait');

    // Guarded: the same wait cannot end the process, so the run has to end some other way — a
    // timeout, a rejection, something a person or a CI log can read.
    const guarded = runningScript(
      `void (async () => { await withLoopAlive(() => new Promise(() => {})); })();`,
    );
    const exited = await Promise.race([
      guarded.closed.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    guarded.kill();

    assert.false(exited, 'still waiting a second later, instead of having exited 0');
  });
});

const UTILITY = new URL('../../lib/utils/with-loop-alive.ts', import.meta.url).href;

/** Spawns a child that has `withLoopAlive` in scope, and the handle to stop it again. */
function runningScript(body: string): {
  closed: Promise<number | null>;
  kill: () => void;
} {
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `const { withLoopAlive } = await import(${JSON.stringify(UTILITY)});\n${body}`,
  ]);

  return {
    closed: new Promise((resolve) => child.on('close', resolve)),
    kill: () => void child.kill('SIGKILL'),
  };
}

function runScript(body: string): Promise<{ code: number | null }> {
  return runningScript(body).closed.then((code) => ({ code }));
}
