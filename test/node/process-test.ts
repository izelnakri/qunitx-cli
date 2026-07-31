import { module, test } from 'qunitx';
import { Node, memoryHub, Process } from '../../lib/node/index.ts';
import { Failure } from '../../lib/result/index.ts';

const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

const counter = () => ({
  version: '1',
  init: () => 0,
  handlers: {
    bump: (n: number) => ({ state: n + 1, reply: n + 1 }),
    whoami: (n: number, _p: unknown, self: { name: string }) => ({ state: n, reply: self.name }),
  },
});

module('Node | Process (Elixir Process module)', () => {
  test('spawn creates an anonymous, handle-addressed unit; each name is unique', async (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    const a = Process.spawn(node, counter());
    const b = Process.spawn(node, counter());

    // Independent units — bumping one doesn't touch the other.
    assert.strictEqual(await a.call('bump'), 1);
    assert.strictEqual(await a.call('bump'), 2);
    assert.strictEqual(await b.call('bump'), 1, 'b is a separate unit with its own state');

    const [nameA, nameB] = [await a.call('whoami'), await b.call('whoami')];
    assert.notStrictEqual(nameA, nameB, 'each spawn got a distinct auto-name');
    assert.true(
      String(nameA).startsWith('a@proc:proc:'),
      'the auto-name is node-scoped (<node>:proc:<n>)',
    );
    node.stop();
  });

  test('alive / exit are the free-function forms of the handle ops', (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    const unit = Process.spawn(node, counter());
    assert.true(Process.alive(unit), 'a fresh unit is alive');
    Process.exit(unit);
    assert.false(Process.alive(unit), 'Process.exit terminated it');
    node.stop();
  });

  test('link propagates an exit — a linked unit dies with its partner', (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    const boss = Process.spawn(node, counter());
    const worker = Process.spawn(node, counter());
    Process.link(boss, worker);

    const Boom = Failure.define('Boom', 'boss died');
    Process.exit(boss, Boom());
    assert.false(Process.alive(boss), 'the boss exited');
    assert.false(Process.alive(worker), 'the linked worker died with it (no trap)');
    node.stop();
  });

  test('whereis / list read the LOCAL table; a dead unit leaves it (no leak)', async (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    const unit = Process.spawn(node, counter());
    const name = String(await unit.call('whoami')); // its auto-assigned name

    assert.strictEqual(
      Process.whereis(node, name),
      'a@proc',
      'the live unit is found on this node',
    );
    assert.strictEqual(Process.whereis(node, 'ghost'), null, 'an unknown name resolves to null');
    assert.deepEqual(Process.list(node), [name], 'list reports the one unit served here');

    Process.exit(unit);
    assert.strictEqual(Process.whereis(node, name), null, 'a dead unit is no longer whereis-able');
    assert.deepEqual(Process.list(node), [], 'and it left the local table — no dead-entry leak');
    node.stop();
  });

  test('whereisName resolves a via-registered name to its host node (cluster lookup)', (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    Process.spawn(node, counter(), { via: { registry: 'reg', key: 'k1' } });

    assert.strictEqual(
      Process.whereisName(node, 'reg', 'k1'),
      'a@proc',
      'the registered unit is hosted here',
    );
    assert.strictEqual(
      Process.whereisName(node, 'reg', 'nope'),
      null,
      'an unknown key resolves to null',
    );
    node.stop();
  });

  test('Process.of(node) binds the node — same behavior, node-free calls', async (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    const P = Process.of(node);

    const unit = P.spawn(counter()); // no node argument
    const name = String(await unit.call('whoami'));
    assert.strictEqual(await unit.call('bump'), 1, 'spawned via the bound namespace');
    assert.strictEqual(P.whereis(name), 'a@proc', 'bound whereis finds it — no node passed');
    assert.deepEqual(P.list(), [name], 'bound list reads the same local table');
    assert.true(P.alive(unit), 'handle-based ops pass through unchanged');

    // The bound namespace and the free functions are two views of ONE node.
    assert.deepEqual(P.list(), Process.list(node), 'P.list() === Process.list(node)');

    P.exit(unit);
    assert.deepEqual(P.list(), [], 'a dead unit leaves the table, seen through the bound view too');
    node.stop();
  });
});

const guardBehavior = () => ({
  version: '1',
  init: () => 0,
  handlers: { noop: (n: number) => ({ state: n, reply: n }) },
});

module('Node | Process.spawn (bare processes — Erlang spawn/1,3)', () => {
  test('spawn(fun) runs the body, receives self, and exits when it returns', async (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    let seenName = '';
    const p = Process.spawn(node, (self) => {
      seenName = self.name;
    });
    assert.true(Process.alive(p), 'alive immediately — the body runs on a microtask');
    assert.true(String(p.name).startsWith('a@proc:proc:'), 'auto-named like any spawn');
    await settle();
    assert.strictEqual(seenName, p.name, 'the body received self (its own name)');
    assert.false(Process.alive(p), 'it exited when the body returned');
    node.stop();
  });

  test('an async body stays alive until it settles; it is in the local table meanwhile', async (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const p = Process.spawn(node, async () => {
      await gate;
    });
    await settle();
    assert.true(Process.alive(p), 'still alive while the body awaits');
    assert.true(Process.list(node).includes(p.name), 'and listed in the local process table');
    release();
    await settle();
    assert.false(Process.alive(p), 'exits once the body resolves');
    assert.false(Process.list(node).includes(p.name), 'and leaves the table');
    node.stop();
  });

  test('a NORMAL exit (body returns) does not disturb a linked unit — Erlang :normal', async (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    const guard = Process.spawn(node, guardBehavior());
    const p = Process.spawn(node, () => {}, { link: guard }); // spawn_link
    await settle();
    assert.false(Process.alive(p), 'the process finished');
    assert.true(
      Process.alive(guard),
      'the linked unit SURVIVED — a normal exit does not propagate',
    );
    node.stop();
  });

  test('an ABNORMAL exit (body throws) propagates to a linked unit', async (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    const guard = Process.spawn(node, guardBehavior());
    Process.spawn(
      node,
      () => {
        throw new Error('boom');
      },
      { link: guard },
    );
    await settle();
    assert.false(Process.alive(guard), 'the linked unit died — an abnormal exit propagates');
    node.stop();
  });

  test('the module form runs mod.fn(self, ...args) — Erlang spawn/3', async (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    const calls: unknown[] = [];
    const mod = {
      work: (self: { name: string }, x: number, y: number) => {
        calls.push([String(self.name).startsWith('a@proc'), x, y]);
      },
    };
    const p = Process.spawn(node, mod, 'work', [1, 2]);
    await settle();
    assert.deepEqual(calls, [[true, 1, 2]], 'mod.work got self followed by the args');
    assert.false(Process.alive(p), 'and it exited on completion');
    node.stop();
  });

  test('a process can exit itself early via self.exit', async (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    const p = Process.spawn(node, (self) => self.exit());
    await settle();
    assert.false(Process.alive(p), 'self.exit terminated it');
    node.stop();
  });

  test('a throwing process delivers ProcessCrashed (with the cause) to a trapping linked unit', async (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    const trapped: { code: string; causeMessage: string }[] = [];
    const guard = Process.spawn(node, guardBehavior());
    guard.trapExit((_from, reason) =>
      trapped.push({
        code: (reason as Failure.Any).code,
        causeMessage: String((reason as Failure.Any).cause),
      }),
    );
    Process.spawn(
      node,
      () => {
        throw new Error('kaboom');
      },
      { link: guard },
    );
    await settle();

    assert.true(Process.alive(guard), 'the trapping unit survived the linked crash');
    assert.strictEqual(trapped.length, 1, 'and received exactly one exit signal');
    assert.strictEqual(trapped[0].code, 'ProcessCrashed', 'the reason is ProcessCrashed');
    assert.true(trapped[0].causeMessage.includes('kaboom'), 'carrying the original error as cause');
    node.stop();
  });

  test('a trapping unit is signalled on BOTH a normal and an abnormal linked exit; survives both', async (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    const signals: string[] = [];
    const guard = Process.spawn(node, guardBehavior());
    guard.trapExit((_from, reason) => signals.push((reason as Failure.Any).code));

    Process.spawn(node, () => {}, { link: guard }); // normal exit
    await settle();
    assert.true(Process.alive(guard), 'guard survives the normal exit');
    assert.deepEqual(
      signals,
      ['Normal'],
      'a trapper IS told of a normal completion (Erlang {EXIT,_,normal})',
    );

    Process.spawn(
      node,
      () => {
        throw new Error('boom');
      },
      { link: guard },
    ); // abnormal exit
    await settle();
    assert.true(Process.alive(guard), 'guard still alive (it traps)');
    assert.deepEqual(signals, ['Normal', 'ProcessCrashed'], 'and of an abnormal one, distinctly');
    node.stop();
  });

  test('completion tracking: a trapping coordinator learns when each linked worker finishes', async (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    let done = 0;
    const coordinator = Process.spawn(node, guardBehavior());
    coordinator.trapExit((_from, reason) => {
      if ((reason as Failure.Any).code === 'Normal') done += 1; // count clean completions
    });
    for (let i = 0; i < 5; i += 1)
      Process.spawn(node, async () => await settle(5), { link: coordinator });
    await settle(40);
    assert.strictEqual(
      done,
      5,
      'the coordinator was notified of all 5 completions — link+trap tracks work',
    );
    assert.true(Process.alive(coordinator), 'and it stayed up throughout');
    node.stop();
  });

  test('links are symmetric: exiting the linked unit takes the bare process down too', async (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    const owner = Process.spawn(node, guardBehavior());
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const p = Process.spawn(node, async () => await gate, { link: owner }); // long-lived, linked

    await settle();
    assert.true(Process.alive(p), 'the bare process is running');
    Process.exit(owner, Failure.define('OwnerDown', 'boom')());
    await settle();
    assert.false(
      Process.alive(p),
      'the linked bare process died with the owner (reverse direction)',
    );
    release();
    node.stop();
  });

  test('a bare process links to another bare process — one crash fells the other (Pid ↔ Pid)', async (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const b = Process.spawn(node, async () => await gate); // long-lived
    Process.spawn(
      node,
      () => {
        throw new Error('a-crash');
      },
      { link: b },
    );
    await settle();
    assert.false(Process.alive(b), 'b died when its linked partner crashed');
    release();
    node.stop();
  });

  test('a live bare process is whereis-able and listed by its auto-name; gone after it exits', async (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const p = Process.spawn(node, async () => await gate);

    assert.strictEqual(
      Process.whereis(node, p.name),
      'a@proc',
      'found locally by name while alive',
    );
    assert.true(Process.list(node).includes(p.name), 'and present in the local process list');
    release();
    await settle();
    assert.strictEqual(Process.whereis(node, p.name), null, 'no longer whereis-able once it exits');
    assert.false(Process.list(node).includes(p.name), 'and gone from the list');
    node.stop();
  });

  test('many bare spawns get distinct auto-names — no collision at volume', (assert) => {
    const node = Node.start('a@proc', memoryHub().transport());
    const names = new Set<string>();
    for (let i = 0; i < 1000; i += 1) names.add(Process.spawn(node, () => {}).name);
    assert.strictEqual(names.size, 1000, '1000 spawns → 1000 unique names');
    node.stop();
  });
});
