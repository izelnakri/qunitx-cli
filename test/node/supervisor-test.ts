import { module, test } from 'qunitx';
import { supervisor, type Service } from '../../lib/node/index.ts';

// A test service: logs start/stop, carries a unique instance id (so a restart is observable as a
// NEW id), and exposes `crash(reason)` to fire its onExit — the abnormal-exit signal.
let nextId = 0;
interface TestService extends Service {
  name: string;
  id: number;
  crash(reason?: unknown): void;
}
const child = (name: string, log: string[], restart?: 'permanent' | 'transient' | 'temporary') => ({
  name,
  restart,
  start: (get: <T = unknown>(n: string) => T): TestService => {
    log.push(`start:${name}`);
    let onExitHandler: ((reason?: unknown) => void) | undefined;
    return {
      name,
      id: ++nextId,
      get, // keep the resolver so a restarted child could look up siblings
      stop: () => void log.push(`stop:${name}`),
      onExit: (handler) => void (onExitHandler = handler),
      crash: (reason) => onExitHandler?.(reason),
    } as TestService & { get: unknown };
  },
});

module('Node | supervisor (OTP Supervisor + Application)', () => {
  test('starts in order, stops in reverse; get() resolves the current child', async (assert) => {
    const log: string[] = [];
    const app = supervisor([child('store', log), child('jobs', log), child('web', log)]);
    await app.start();
    assert.deepEqual(
      log,
      ['start:store', 'start:jobs', 'start:web'],
      'children start in spec order',
    );
    assert.equal(app.get<TestService>('jobs').name, 'jobs', 'get() resolves a named child');
    assert.throws(() => app.get('nope'), /no started child/, 'unknown name throws');

    await app.stop();
    assert.deepEqual(
      log.slice(3),
      ['stop:web', 'stop:jobs', 'stop:store'],
      'children stop in REVERSE order — graceful shutdown',
    );
  });

  test('one_for_one: only the crashed child restarts (a fresh instance)', async (assert) => {
    const log: string[] = [];
    const app = supervisor([child('a', log), child('b', log), child('c', log)]);
    await app.start();
    const beforeA = app.get<TestService>('a').id;
    const beforeB = app.get<TestService>('b').id;

    app.get<TestService>('b').crash(new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the async restart settle

    assert.equal(app.get<TestService>('a').id, beforeA, 'sibling a untouched');
    assert.notEqual(app.get<TestService>('b').id, beforeB, 'b is a fresh instance');
    assert.equal(log.at(-2), 'stop:b', 'b was stopped');
    assert.equal(log.at(-1), 'start:b', 'then restarted');
    await app.stop();
  });

  test('rest_for_one: the crashed child and everything after it restart; earlier untouched', async (assert) => {
    const log: string[] = [];
    const app = supervisor([child('a', log), child('b', log), child('c', log)], {
      strategy: 'rest_for_one',
    });
    await app.start();
    const ids = () => ['a', 'b', 'c'].map((n) => app.get<TestService>(n).id);
    const before = ids();

    app.get<TestService>('b').crash(new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = ids();

    assert.equal(after[0], before[0], 'a (before b) untouched');
    assert.notEqual(after[1], before[1], 'b restarted');
    assert.notEqual(after[2], before[2], 'c (after b) restarted too');
  });

  test('one_for_all: any crash restarts every child', async (assert) => {
    const log: string[] = [];
    const app = supervisor([child('a', log), child('b', log)], { strategy: 'one_for_all' });
    await app.start();
    const before = ['a', 'b'].map((n) => app.get<TestService>(n).id);

    app.get<TestService>('a').crash(new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const after = ['a', 'b'].map((n) => app.get<TestService>(n).id);
    assert.notEqual(after[0], before[0], 'a restarted');
    assert.notEqual(after[1], before[1], 'b restarted too — one_for_all');
  });

  test('restart types: temporary never restarts; transient restarts only on abnormal exit', async (assert) => {
    const log: string[] = [];
    const app = supervisor([child('temp', log, 'temporary'), child('trans', log, 'transient')]);
    await app.start();
    const tempId = app.get<TestService>('temp').id;
    const transId = app.get<TestService>('trans').id;

    app.get<TestService>('temp').crash(new Error('boom'));
    app.get<TestService>('trans').crash(undefined); // a NORMAL exit
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(app.get<TestService>('temp').id, tempId, 'temporary child is not restarted');
    assert.equal(
      app.get<TestService>('trans').id,
      transId,
      'transient child not restarted on a normal exit',
    );

    app.get<TestService>('trans').crash(new Error('boom')); // now an ABNORMAL exit
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.notEqual(
      app.get<TestService>('trans').id,
      transId,
      'transient child IS restarted on an abnormal exit',
    );
    await app.stop();
  });

  test('warns when a restartable child cannot report a crash (no onExit)', async (assert) => {
    const warnings: string[] = [];
    const app = supervisor(
      [{ name: 'inert', start: () => ({ stop: () => {} }), restart: 'permanent' }],
      { warn: (message) => warnings.push(message) },
    );
    await app.start();
    assert.equal(
      warnings.length,
      1,
      'one warning — restart requested but the child cannot signal a crash',
    );
    assert.true(warnings[0].includes("child 'inert'"), 'names the offending child');
    assert.true(warnings[0].includes('onExit'), 'points at the fix');
    await app.stop();
  });

  test('restart intensity: a crash-loop shuts the whole tree down (OTP max_restarts)', async (assert) => {
    const shutdowns: string[] = [];
    let live: TestService | undefined;
    const app = supervisor(
      [
        {
          name: 'flapper',
          restart: 'permanent',
          start: () => {
            let onExitHandler: ((reason?: unknown) => void) | undefined;
            live = {
              name: 'flapper',
              id: ++nextId,
              stop: () => {},
              onExit: (handler) => void (onExitHandler = handler),
              crash: (reason) => onExitHandler?.(reason),
            };
            return live;
          },
        },
      ],
      {
        maxRestarts: 3,
        maxSeconds: 5,
        now: () => 0,
        onShutdown: (reason) => shutdowns.push(reason),
      },
    );
    await app.start();

    for (let index = 0; index < 4; index += 1) {
      live!.crash(new Error('boom')); // crash the current instance
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.deepEqual(
      shutdowns,
      ['restart-intensity'],
      'after > maxRestarts restarts in the window, the supervisor gave up and shut down',
    );
  });
});
