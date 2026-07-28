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

    served.upgrade({
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

    served.upgrade({
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
