import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { Failure } from '../../lib/task/index.ts';

// A next version as a MODULE, the way a real relup ships one: data: URLs make the "code
// server" runnable on both lanes with no filesystem — in production this is an https:// or
// file:// URL to the new build.
const V2_URL =
  'data:text/javascript,' +
  encodeURIComponent(`export default {
    version: '2.0.0',
    handlers: {
      hello: (state, name) => ({ state: { greeted: state.greeted + 1 }, reply: 'Hallo ' + name + ' #' + (state.greeted + 1) }),
      stats: (state) => ({ state, reply: state.greeted }),
    },
    codeChange: (fromVersion, oldState) => ({ greeted: oldState.greeted, migratedFrom: fromVersion }),
  };`);

const v1 = () => ({
  version: '1.0.0',
  init: () => ({ greeted: 0 }),
  handlers: {
    hello: (state: { greeted: number }, name: unknown) => ({
      state: { greeted: state.greeted + 1 },
      reply: `Hello ${name}`,
    }),
  },
});

module('Node | hot upgrades', () => {
  test('local upgrade mid-traffic: state crosses through codeChange, atomically', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const cli = Node.start('cli@memory', hub.transport());
    const served = Node.serve(svc, 'greeter', v1());

    assert.strictEqual(await cli.call('svc@memory', 'greeter.hello', 'ada'), 'Hello ada');
    assert.strictEqual(await cli.call('svc@memory', 'greeter.hello', 'bo'), 'Hello bo');

    await served.upgrade({
      version: '1.1.0',
      handlers: {
        hello: (state, name) => ({
          state: { greeted: state.greeted + 1 },
          reply: `Hi ${name} (#${state.greeted + 1})`,
        }),
      },
    });
    assert.strictEqual(
      await cli.call('svc@memory', 'greeter.hello', 'cy'),
      'Hi cy (#3)',
      'the greet COUNT survived the swap — no codeChange needed for a same-shape state',
    );
    assert.strictEqual(served.version(), '1.1.0');
    svc.stop();
    cli.stop();
  });

  test('the relup: a REMOTE node upgrades via <name>.sys.upgrade with a module URL', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const ops = Node.start('ops@memory', hub.transport());
    Node.serve(svc, 'greeter', v1());

    await ops.call('svc@memory', 'greeter.hello', 'ada');
    assert.strictEqual(await ops.call('svc@memory', 'greeter.sys.version'), '1.0.0');

    const upgraded = await ops.call('svc@memory', 'greeter.sys.upgrade', { url: V2_URL });
    assert.strictEqual(upgraded, '2.0.0', 'the remote node reports its new version');
    assert.strictEqual(
      await ops.call('svc@memory', 'greeter.hello', 'bo'),
      'Hallo bo #2',
      'new code, old state: the count crossed through codeChange',
    );
    assert.strictEqual(
      await ops.call('svc@memory', 'greeter.stats'),
      2,
      'a handler key that only v2 has',
    );
    svc.stop();
    ops.stop();
  });

  test('the downgrade is the same mechanism pointed at the older version', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const ops = Node.start('ops@memory', hub.transport());
    const served = Node.serve(svc, 'greeter', v1());

    await ops.call('svc@memory', 'greeter.sys.upgrade', { url: V2_URL });
    await ops.call('svc@memory', 'greeter.hello', 'ada');

    await served.upgrade({
      ...v1(),
      codeChange: (fromVersion, old) => {
        assert.strictEqual(fromVersion, '2.0.0', 'codeChange knows which way it came');
        return { greeted: (old as { greeted: number }).greeted };
      },
    });
    assert.strictEqual(
      await ops.call('svc@memory', 'greeter.hello', 'bo'),
      'Hello bo',
      'v1 behavior again',
    );
    assert.strictEqual(
      (served.state() as { greeted: number }).greeted,
      2,
      'count intact across BOTH hops',
    );
    svc.stop();
    ops.stop();
  });
});

module('Node | mailbox serialization', () => {
  test('overlapping ASYNC handlers run strictly one at a time — gen_server semantics', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const cli = Node.start('cli@memory', hub.transport());
    const trace: string[] = [];
    const served = Node.serve(svc, 'acct', {
      version: '1',
      init: () => 0,
      handlers: {
        deposit: async (state, amount) => {
          trace.push(`start:${amount}`);
          await new Promise((r) => setTimeout(r, 20)); // the await that USED to interleave
          trace.push(`end:${amount}`);
          return { state: state + (amount as number), reply: state + (amount as number) };
        },
      },
    });
    const [a, b] = await Promise.all([
      cli.call('svc@memory', 'acct.deposit', 100),
      cli.call('svc@memory', 'acct.deposit', 1),
    ]);
    assert.deepEqual(trace, ['start:100', 'end:100', 'start:1', 'end:1'], 'no interleave');
    assert.deepEqual([a, b], [100, 101], 'the second saw the first COMMITTED state');
    assert.strictEqual(served.state(), 101);
    svc.stop();
    cli.stop();
  });

  test('an upgrade queues BEHIND an in-flight async handler — swaps land between messages', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const cli = Node.start('cli@memory', hub.transport());
    const served = Node.serve(svc, 'slow', {
      version: '1',
      init: () => 'v1-state',
      handlers: {
        work: async (state) => {
          await new Promise((r) => setTimeout(r, 30));
          return { state, reply: `worked on ${state}` };
        },
      },
    });
    const inFlight = cli.call('svc@memory', 'slow.work', null);
    // Genuinely in flight: wait for the frame to reach the unit's mailbox before swapping.
    for (let i = 0; i < 100 && served.mailbox() === 0; i++)
      await new Promise((r) => setTimeout(r, 1));
    assert.strictEqual(served.mailbox(), 1, 'the work message is being pumped');
    const swap = served.upgrade({
      version: '2',
      handlers: { work: (state) => ({ state, reply: `v2 ${state}` }) },
      codeChange: (_from, old) => `${old}→migrated`,
    });
    assert.strictEqual(await inFlight, 'worked on v1-state', 'in-flight completed on OLD code');
    assert.strictEqual(await swap, '2');
    assert.strictEqual(await cli.call('svc@memory', 'slow.work', null), 'v2 v1-state→migrated');
    svc.stop();
    cli.stop();
  });
});

// ── Links + trapExit — Erlang's exit signals between served units ─────────────

module('Node | links', () => {
  test('linked units die together; callers get a declared UnitDown', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const cli = Node.start('cli@memory', hub.transport());
    const a = Node.serve(svc, 'a', {
      version: '1',
      init: () => 0,
      handlers: { ping: (s) => ({ state: s, reply: 'a' }) },
    });
    const b = Node.serve(svc, 'b', {
      version: '1',
      init: () => 0,
      handlers: { ping: (s) => ({ state: s, reply: 'b' }) },
    });
    a.link(b);
    a.exit();
    assert.false(a.isAlive());
    assert.false(b.isAlive(), 'the exit signal propagated through the link');
    const down = await cli.call('svc@memory', 'b.ping', null).result();
    assert.strictEqual(
      (down as Failure.Any).code,
      'UnitDown',
      'a dead unit answers declared, never hangs',
    );
    svc.stop();
    cli.stop();
  });

  test('trapExit survives the signal and receives (from, reason) through the MAILBOX', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const worker = Node.serve(svc, 'worker', { version: '1', init: () => 0, handlers: {} });
    const boss = Node.serve(svc, 'boss', { version: '1', init: () => 0, handlers: {} });
    const trapped: string[] = [];
    boss.trapExit((from, reason) => void trapped.push(`${from}:${reason.code}`));
    boss.link(worker);
    worker.exit(Failure.define('OOM', 'out of memory')());
    await new Promise((r) => setTimeout(r, 10)); // trap rides the mailbox
    assert.true(boss.isAlive(), 'the trapping unit survived');
    assert.deepEqual(trapped, ['worker:OOM'], 'and learned who died and why');
    svc.stop();
  });

  test('exit reasons chain: the linked death carries the original as cause', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const cli = Node.start('cli@memory', hub.transport());
    const a = Node.serve(svc, 'x', { version: '1', init: () => 0, handlers: {} });
    const b = Node.serve(svc, 'y', {
      version: '1',
      init: () => 0,
      handlers: { ping: (s) => ({ state: s, reply: 1 }) },
    });
    b.link(a);
    const Boom = Failure.define('Boom', 'kaboom');
    a.exit(Boom());
    const down = await cli.call('svc@memory', 'y.ping', null).result();
    assert.strictEqual((down as Failure.Any).code, 'UnitDown');
    assert.true(
      Boom.is((down as Failure.Any).cause),
      'the original reason crossed the wire, revived',
    );
    svc.stop();
    cli.stop();
  });
});

// ── maxMailbox — load shedding, BEAM's unbounded-mailbox footgun made disciplined ─

module('Node | mailbox backpressure', () => {
  test('a full mailbox sheds new work as a declared Overloaded', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const cli = Node.start('cli@memory', hub.transport());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    Node.serve(
      svc,
      'slow',
      {
        version: '1',
        init: () => 0,
        handlers: { work: async (s) => (await gate, { state: s + 1, reply: 'ok' }) },
      },
      { maxMailbox: 2 }, // 1 in flight + at most 2 queued
    );

    // Fire five concurrently: #1 pumps, #2 #3 queue (depth 1,2), #4 #5 see depth>=2 → shed.
    const pending = [1, 2, 3, 4, 5].map(() => cli.call('svc@memory', 'slow.work', null).result());
    await new Promise((r) => setTimeout(r, 20)); // let all five reach the mailbox and settle depth
    release(); // NOW let the queued handlers finish (releasing before awaiting avoids deadlock)
    const outcomes = await Promise.all(pending);

    const shed = outcomes.filter((o) => Failure.is(o) && (o as Failure.Any).code === 'Overloaded');
    const ok = outcomes.filter((o) => o === 'ok');
    assert.strictEqual(shed.length, 2, 'two requests shed rather than queued unboundedly');
    assert.strictEqual(ok.length, 3, 'the in-flight one plus the two that fit were served');
    assert.strictEqual(
      (shed[0] as Failure.Any).data.unit,
      'slow',
      'the shed failure names the overloaded unit',
    );
    svc.stop();
    cli.stop();
  });
});

// ── persistence seam — restore + persist-before-ack (the delta-loss fix) ─────

module('Node | persistence', () => {
  const counter = (): Node.Behavior<{ n: number }> => ({
    version: '1',
    init: () => ({ n: 0 }),
    handlers: {
      bump: (s) => ({ state: { n: s.n + 1 }, reply: s.n + 1 }),
      read: (s) => ({ state: s, reply: s.n, persist: false }), // read: no write
    },
  });

  test('state rehydrates from the store on a fresh serve() — survives a restart', async (assert) => {
    const store = Node.memoryStore();
    const hub = Node.memoryHub();
    const cli = Node.start('cli@memory', hub.transport());

    const first = Node.start('svc@memory', hub.transport());
    Node.serve(first, 'ctr', counter(), { store, storeKey: 'ctr' });
    await cli.call('svc@memory', 'ctr.bump');
    await cli.call('svc@memory', 'ctr.bump'); // n = 2, both persisted before ack
    first.stop();

    // A brand-new node + serve() over the SAME store — like a supervised restart / new pod.
    const second = Node.start('svc2@memory', hub.transport());
    Node.serve(second, 'ctr', counter(), { store, storeKey: 'ctr' });
    assert.strictEqual(
      await cli.call('svc2@memory', 'ctr.read'),
      2,
      'the count survived — rehydrated',
    );
    second.stop();
    cli.stop();
  });

  test('persist happens BEFORE the reply is released (durable-before-ack)', async (assert) => {
    const writes: number[] = [];
    const store: Node.Store = {
      load: () => Promise.resolve(undefined),
      save: async (_k, s) => {
        await new Promise((r) => setTimeout(r, 15)); // a slow durable write
        writes.push((s as { n: number }).n);
      },
      clear: () => Promise.resolve(),
    };
    const hub = Node.memoryHub();
    const cli = Node.start('cli@memory', hub.transport());
    const svc = Node.start('svc@memory', hub.transport());
    Node.serve(svc, 'ctr', counter(), { store });
    const reply = await cli.call('svc@memory', 'ctr.bump');
    assert.strictEqual(reply, 1);
    assert.deepEqual(writes, [1], 'the write had completed by the time the caller got its ack');
    svc.stop();
    cli.stop();
  });

  test('reads (persist:false) do not write', async (assert) => {
    let saves = 0;
    const store: Node.Store = {
      load: () => Promise.resolve(undefined),
      save: () => (saves++, Promise.resolve()),
      clear: () => Promise.resolve(),
    };
    const hub = Node.memoryHub();
    const cli = Node.start('cli@memory', hub.transport());
    const svc = Node.start('svc@memory', hub.transport());
    Node.serve(svc, 'ctr', counter(), { store });
    await cli.call('svc@memory', 'ctr.bump'); // writes
    await cli.call('svc@memory', 'ctr.read'); // must not write
    await cli.call('svc@memory', 'ctr.read');
    assert.strictEqual(saves, 1, 'only the mutating call persisted');
    svc.stop();
    cli.stop();
  });
});
