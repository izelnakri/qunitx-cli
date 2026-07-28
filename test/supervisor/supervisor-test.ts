import { module, test } from 'qunitx';
import * as Supervisor from '../../lib/supervisor/index.ts';
import { Failure } from '../../lib/task/index.ts';

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

// A controllable child: runs until aborted; crash() makes the CURRENT incarnation reject.
function worker(log: string[], id: string) {
  let crash!: (reason: Error) => void;
  const spec: Supervisor.ChildSpec = {
    id,
    start: (signal) =>
      new Promise<void>((resolve, reject) => {
        log.push(`start:${id}`);
        crash = reject;
        signal.addEventListener('abort', () => (log.push(`abort:${id}`), resolve()));
      }),
  };
  return { spec, crash: () => crash(new Error(`${id} crashed`)) };
}

module('Supervisor | policies', () => {
  test('permanent restarts on any exit; transient only on crash; temporary never', async (assert) => {
    let permanentRuns = 0;
    let transientRuns = 0;
    let temporaryRuns = 0;
    const sup = Supervisor.start(
      [
        {
          id: 'p',
          restart: 'permanent',
          start: (signal) => {
            permanentRuns += 1;
            if (permanentRuns < 3) return; // two NORMAL exits — permanent restarts anyway…
            return new Promise<void>((res) => signal.addEventListener('abort', () => res())); // …then park
          },
        },
        {
          id: 'tr',
          restart: 'transient',
          start: () => {
            transientRuns += 1;
            if (transientRuns === 1) throw new Error('once');
          },
        },
        {
          id: 'te',
          restart: 'temporary',
          start: () => {
            temporaryRuns += 1;
            throw new Error('always');
          },
        },
      ],
      { maxRestarts: 4, maxSeconds: 5 },
    );
    await tick(40);
    assert.strictEqual(permanentRuns, 3, 'permanent restarted even after NORMAL exits');
    assert.strictEqual(transientRuns, 2, 'transient restarted after the crash, then stayed exited');
    assert.strictEqual(temporaryRuns, 1, 'temporary never restarted');
    await sup.stop();
  });

  test('the intensity budget ends the tree loudly: done rejects SupervisorShutdown', async (assert) => {
    const observedCodes: string[] = [];
    Failure.onObserved((f) => observedCodes.push(f.code));
    try {
      const sup = Supervisor.start(
        [
          {
            id: 'looper',
            restart: 'permanent',
            start: () => {
              throw new Error('crashloop');
            },
          },
        ],
        { maxRestarts: 2, maxSeconds: 5 },
      );
      const outcome = await sup.done.result();
      assert.true(Failure.is(outcome));
      assert.strictEqual((outcome as Failure.Any).code, 'SupervisorShutdown');
      assert.strictEqual(sup.count(), 0, 'nothing left running');
      assert.true(observedCodes.length >= 3, 'each handled crash reported to the observation seam');
    } finally {
      Failure.onObserved(null);
    }
  });
});

module('Supervisor | strategies', () => {
  test('oneForOne restarts only the crashed child', async (assert) => {
    const log: string[] = [];
    const a = worker(log, 'a');
    const b = worker(log, 'b');
    const sup = Supervisor.start([a.spec, b.spec], { strategy: 'oneForOne', maxRestarts: 5 });
    await tick();
    a.crash();
    await tick();
    assert.deepEqual(log, ['start:a', 'start:b', 'start:a'], 'b untouched');
    await sup.stop();
  });

  test('oneForAll takes every child down (reverse order) and restarts all (start order)', async (assert) => {
    const log: string[] = [];
    const a = worker(log, 'a');
    const b = worker(log, 'b');
    const c = worker(log, 'c');
    const sup = Supervisor.start([a.spec, b.spec, c.spec], {
      strategy: 'oneForAll',
      maxRestarts: 5,
    });
    await tick();
    b.crash();
    await tick();
    assert.deepEqual(log, [
      'start:a',
      'start:b',
      'start:c',
      'abort:c',
      'abort:a', // peers stopped in REVERSE start order
      'start:a',
      'start:b',
      'start:c', // all respawned in start order
    ]);
    await sup.stop();
  });

  test('restForOne restarts the crashed child and everything started after it', async (assert) => {
    const log: string[] = [];
    const a = worker(log, 'a');
    const b = worker(log, 'b');
    const c = worker(log, 'c');
    const sup = Supervisor.start([a.spec, b.spec, c.spec], {
      strategy: 'restForOne',
      maxRestarts: 5,
    });
    await tick();
    b.crash();
    await tick();
    assert.deepEqual(
      log,
      ['start:a', 'start:b', 'start:c', 'abort:c', 'start:b', 'start:c'],
      'a untouched',
    );
    await sup.stop();
  });
});

module('Supervisor | lifecycle', () => {
  test('stop aborts in reverse start order, resolves done, and count reaches zero', async (assert) => {
    const log: string[] = [];
    const a = worker(log, 'a');
    const b = worker(log, 'b');
    const sup = Supervisor.start([a.spec, b.spec]);
    await tick();
    assert.deepEqual(sup.children(), ['a', 'b']);
    assert.strictEqual(sup.count(), 2);
    await sup.stop();
    await sup.done; // resolves — a clean stop is not a failure
    assert.deepEqual(log, ['start:a', 'start:b', 'abort:b', 'abort:a']);
    assert.strictEqual(sup.count(), 0);
  });
});
