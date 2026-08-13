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
    const served = Node.genServer(svc, 'greeter', v1());

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
    Node.genServer(svc, 'greeter', v1());

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
    const served = Node.genServer(svc, 'greeter', v1());

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
    const served = Node.genServer(svc, 'acct', {
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
    const served = Node.genServer(svc, 'slow', {
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

module('Node | typed local client', () => {
  test('call/cast invoke handlers in-process — through the mailbox, no wire hop', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const store = Node.memoryStore();
    const NonPositive = Failure.define('NonPositive', 'bump must be > 0');
    const counter = Node.genServer(
      svc,
      'counter',
      {
        version: '1',
        init: () => 0,
        handlers: {
          bump: (state, by) => {
            const n = by as number;
            if (n <= 0) return { state, reply: NonPositive() }; // a declared Failure AS the reply
            return { state: state + n, reply: state + n };
          },
          reset: () => ({ state: 0, reply: undefined }),
        },
      },
      { store, storeKey: 'counter:1' },
    );

    // `subject` is constrained to the handler keys — 'bump'/'reset' typecheck, anything else wouldn't.
    assert.strictEqual(
      await counter.call('bump', 2),
      2,
      'local call ran the handler, reply crossed',
    );
    assert.strictEqual(await counter.call('bump', 3), 5, 'the next call saw the committed state');
    assert.strictEqual(counter.state(), 5);

    // A declared Failure reply rejects the Task, exactly like a remote call would surface it.
    const bad = await counter.call('bump', -1).result();
    assert.true(NonPositive.is(bad), 'a Failure reply rejects the local Task');
    assert.strictEqual(counter.state(), 5, 'the rejecting handler left state untouched');

    // cast mutates + persists through the same mailbox but drops the reply.
    counter.cast('reset');
    await counter.call('bump', 1); // ordering barrier: the cast is pumped before this resolves
    assert.strictEqual(counter.state(), 1, 'cast ran (reset to 0) ahead of the following bump');

    // Persisted through the store like any message — a fresh genServer rehydrates it.
    assert.strictEqual(
      await store.load('counter:1'),
      1,
      'cast + call both persisted (durable-before-ack)',
    );
    svc.stop();
  });
});

module('Node | crashOnError (let it crash)', () => {
  test('a handler BUG terminates the unit; a declared Failure is just a reply', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const Rejected = Failure.define('Rejected', 'declared + expected — not a crash');
    const unit = Node.genServer(
      svc,
      'risky',
      {
        version: '1',
        init: () => 0,
        handlers: {
          ok: (n) => ({ state: n + 1, reply: n + 1 }),
          deny: () => {
            throw Rejected(); // a DECLARED Failure — an expected outcome
          },
          boom: () => {
            throw new TypeError('a genuine bug'); // a non-Failure — a crash
          },
        },
      },
      { crashOnError: true },
    );

    assert.strictEqual(await unit.call('ok'), 1, 'serves normally');

    // A thrown declared Failure is an expected reply — it does NOT crash the unit.
    const denied = await unit.call('deny').result();
    assert.true(Rejected.is(denied), 'a thrown declared Failure came back as a reply');
    assert.true(unit.isAlive(), 'a declared Failure did NOT crash the unit');
    assert.strictEqual(await unit.call('ok'), 2, 'still serving; state intact (1 → 2)');

    // A bug (non-Failure throw) crashes: the caller gets UnitCrashed, the unit terminates.
    const crashed = (await unit.call('boom').result()) as Failure.Any;
    assert.strictEqual(crashed.code, 'UnitCrashed', 'the in-flight caller learns the unit crashed');
    assert.true(
      String(crashed.message).includes('a genuine bug'),
      'the crash reason carries the original bug text',
    );
    assert.false(unit.isAlive(), 'the unit terminated on the bug — let it crash');
    assert.strictEqual(
      ((await unit.call('ok').result()) as Failure.Any).code,
      'UnitCrashed',
      'subsequent calls hit the dead unit and get its crash reason back',
    );
    svc.stop();
  });

  test('OFF by default: a bug is answered, not fatal — the unit keeps serving', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const cli = Node.start('cli@memory', hub.transport());
    Node.genServer(svc, 'lenient', {
      version: '1',
      init: () => 0,
      handlers: {
        ok: (n) => ({ state: n + 1, reply: n + 1 }),
        boom: () => {
          throw new Error('bug');
        },
      },
    }); // no crashOnError

    const crashed = (await cli.call('svc@memory', 'lenient.boom').result()) as Failure.Any;
    assert.strictEqual(crashed.code, 'RemoteCrash', 'a bug is a RemoteCrash reply by default');
    assert.strictEqual(await cli.call('svc@memory', 'lenient.ok'), 1, 'the unit is still serving');
    svc.stop();
    cli.stop();
  });
});

module('Node | self (the process context)', () => {
  test('self.from is the sender; self.sendAfter schedules a message to itself', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const cli = Node.start('cli@memory', hub.transport());
    const ticker = Node.genServer(svc, 'ticker', {
      version: '1',
      init: () => ({ ticks: 0, lastFrom: '' }),
      handlers: {
        arm: (s, _p, self) => {
          self.sendAfter('tick', null, 15); // Process.send_after(self(), :tick, 15)
          return { state: s, reply: 'armed' };
        },
        tick: (s) => ({ state: { ...s, ticks: s.ticks + 1 }, reply: s.ticks + 1 }),
        who: (s, _p, self) => ({ state: { ...s, lastFrom: self.from }, reply: self.from }),
      },
    });

    assert.strictEqual(
      await cli.call('svc@memory', 'ticker.who', null),
      'cli@memory',
      'self.from is the calling node',
    );
    assert.strictEqual(await ticker.call('arm'), 'armed');
    assert.strictEqual(ticker.state().ticks, 0, 'the tick has not fired yet');
    await new Promise((r) => setTimeout(r, 45));
    assert.strictEqual(
      ticker.state().ticks,
      1,
      'the scheduled self-message fired through the mailbox',
    );
    svc.stop();
    cli.stop();
  });

  test('self.cast enqueues to self — it runs AFTER the current message, serialized', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const trace: string[] = [];
    const chain = Node.genServer(svc, 'chain', {
      version: '1',
      init: () => 0,
      handlers: {
        begin: (n, _p, self) => {
          self.cast('follow', null); // does NOT run now — enqueued behind the current message
          trace.push('begin');
          return { state: n + 1, reply: n + 1 };
        },
        follow: (n) => {
          trace.push('follow');
          return { state: n + 1, reply: n + 1 };
        },
      },
    });

    assert.strictEqual(await chain.call('begin'), 1, 'begin committed first (n 0 → 1)');
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(trace, ['begin', 'follow'], 'the self-cast ran next, never reentrant');
    assert.strictEqual(chain.state(), 2, 'follow saw begin’s committed state (1 → 2)');
    svc.stop();
  });

  test('pending self-timers are cancelled when the unit goes down', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const doomed = Node.genServer(svc, 'doomed', {
      version: '1',
      init: () => 0,
      handlers: {
        arm: (n, _p, self) => {
          self.sendAfter('tick', null, 20);
          return { state: n, reply: 'armed' };
        },
        tick: (n) => ({ state: n + 1, reply: n + 1 }),
      },
    });

    await doomed.call('arm');
    doomed.exit(); // down() clears pending timers
    await new Promise((r) => setTimeout(r, 45));
    assert.false(doomed.isAlive(), 'the unit is down');
    assert.strictEqual(doomed.state(), 0, 'the pending timer was cancelled — tick never fired');
    svc.stop();
  });

  test('a handler can terminate its own unit via self.exit', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const seppuku = Node.genServer(svc, 'seppuku', {
      version: '1',
      init: () => 'alive',
      handlers: {
        stop: (s, _p, self) => {
          self.exit(); // Process.exit(self(), …)
          return { state: s, reply: 'goodbye' };
        },
      },
    });

    assert.strictEqual(await seppuku.call('stop'), 'goodbye', 'the reply still comes back');
    assert.false(seppuku.isAlive(), 'the unit terminated itself');
    svc.stop();
  });

  test('self.deadline / self.trace expose the call meta; a handler can bail on doomed work', async (assert) => {
    const hub = Node.memoryHub();
    const svc = Node.start('svc@memory', hub.transport());
    const cli = Node.start('cli@memory', hub.transport());
    const decisions: string[] = [];
    const worker = Node.genServer(svc, 'worker', {
      version: '1',
      init: () => 0,
      handlers: {
        meta: (s, _p, self) => ({
          state: s,
          reply: { deadline: self.deadline ?? null, traceId: self.trace?.id ?? null },
        }),
        slow: async (s, _p, self) => {
          await new Promise((r) => setTimeout(r, 55));
          // The caller may have given up while we worked — don't bother computing a dead reply.
          const bailed = self.deadline !== undefined && Date.now() > self.deadline;
          decisions.push(bailed ? 'bailed' : 'done');
          return { state: s, reply: bailed ? 'bailed' : 'done' };
        },
      },
    });

    const before = Date.now();
    const seen = (await cli.call('svc@memory', 'worker.meta', null, 5000)) as {
      deadline: number | null;
      traceId: string | null;
    };
    assert.true(
      typeof seen.deadline === 'number' &&
        seen.deadline >= before + 4000 &&
        seen.deadline <= before + 6000,
      'self.deadline ≈ now + the call timeout',
    );
    assert.true(
      typeof seen.traceId === 'string' && seen.traceId.length > 0,
      'self.trace carries the call’s trace id',
    );

    // A local self-call rides no wire — no deadline, no trace.
    const local = (await worker.call('meta')) as {
      deadline: number | null;
      traceId: string | null;
    };
    assert.deepEqual(
      local,
      { deadline: null, traceId: null },
      'a local self-call carries no wire meta',
    );

    // The bail path: a short-deadline call the handler outlives.
    await cli.call('svc@memory', 'worker.slow', null, 30).result(); // client CallTimeout at 30ms
    await new Promise((r) => setTimeout(r, 90)); // let the server-side handler finish its 55ms work
    assert.deepEqual(
      decisions,
      ['bailed'],
      'the handler saw the passed deadline and bailed instead of computing a dead reply',
    );

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
    const a = Node.genServer(svc, 'a', {
      version: '1',
      init: () => 0,
      handlers: { ping: (s) => ({ state: s, reply: 'a' }) },
    });
    const b = Node.genServer(svc, 'b', {
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
    const worker = Node.genServer(svc, 'worker', { version: '1', init: () => 0, handlers: {} });
    const boss = Node.genServer(svc, 'boss', { version: '1', init: () => 0, handlers: {} });
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
    const a = Node.genServer(svc, 'x', { version: '1', init: () => 0, handlers: {} });
    const b = Node.genServer(svc, 'y', {
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
    Node.genServer(
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

  test('state rehydrates from the store on a fresh genServer() — survives a restart', async (assert) => {
    const store = Node.memoryStore();
    const hub = Node.memoryHub();
    const cli = Node.start('cli@memory', hub.transport());

    const first = Node.start('svc@memory', hub.transport());
    Node.genServer(first, 'ctr', counter(), { store, storeKey: 'ctr' });
    await cli.call('svc@memory', 'ctr.bump');
    await cli.call('svc@memory', 'ctr.bump'); // n = 2, both persisted before ack
    first.stop();

    // A brand-new node + genServer() over the SAME store — like a supervised restart / new pod.
    const second = Node.start('svc2@memory', hub.transport());
    Node.genServer(second, 'ctr', counter(), { store, storeKey: 'ctr' });
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
    Node.genServer(svc, 'ctr', counter(), { store });
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
    Node.genServer(svc, 'ctr', counter(), { store });
    await cli.call('svc@memory', 'ctr.bump'); // writes
    await cli.call('svc@memory', 'ctr.read'); // must not write
    await cli.call('svc@memory', 'ctr.read');
    assert.strictEqual(saves, 1, 'only the mutating call persisted');
    svc.stop();
    cli.stop();
  });
});

module('Node | local-unit table', () => {
  test('node.units()/node.unit() expose locally-served units; death removes them', (assert) => {
    const node = Node.start('a@u', Node.memoryHub().transport());
    const noop = { init: () => 0, handlers: { noop: (n: number) => ({ state: n, reply: n }) } };
    Node.genServer(node, 'alpha', { version: '2', ...noop });
    const beta = Node.genServer(node, 'beta', { version: '1', ...noop });

    assert.deepEqual(node.units().sort(), ['alpha', 'beta'], 'both units are in the local table');
    const info = node.unit('alpha');
    assert.strictEqual(info?.version, '2', 'node.unit() returns the live report (version)');
    assert.strictEqual(info?.alive, true, 'and liveness');
    assert.strictEqual(node.unit('ghost'), undefined, 'an unserved name is undefined');

    beta.exit();
    assert.deepEqual(node.units(), ['alpha'], 'a dead unit left the table');
    assert.strictEqual(node.unit('beta'), undefined, 'gone — no lingering entry');
    node.stop();
  });
});
