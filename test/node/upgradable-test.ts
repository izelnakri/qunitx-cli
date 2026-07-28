import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';

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
