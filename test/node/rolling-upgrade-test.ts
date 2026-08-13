import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { rollingUpgrade } from '../../lib/node/rolling-upgrade.ts';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// A v2 module shipped as a data: URL — the relup mechanism, no filesystem needed (prod would be an
// https:// or file:// URL to the new build).
const V2_URL =
  'data:text/javascript,' +
  encodeURIComponent(`export default {
    version: '2.0.0',
    handlers: { hi: (s, name) => ({ state: s, reply: 'v2 ' + name }) },
    codeChange: (_from, old) => old,
  };`);

const v1 = () => ({
  version: '1.0.0',
  init: () => 0,
  handlers: { hi: (s: number, name: unknown) => ({ state: s, reply: `v1 ${name}` }) },
});

module('Node | rolling upgrade', () => {
  test('rolls a new version across every target and verifies each', async (assert) => {
    const hub = Node.memoryHub();
    const ops = Node.start('ops@ru', hub.transport());
    const names = ['a@ru', 'b@ru', 'c@ru'];
    const nodes = names.map((n) => Node.start(n, hub.transport()));
    nodes.forEach((n) => Node.genServer(n, 'greeter', v1()));
    await settle();

    const report = await rollingUpgrade({
      node: ops,
      unit: 'greeter',
      url: V2_URL,
      version: '2.0.0',
      targets: names,
    });
    assert.deepEqual(report.upgraded, names, 'all three upgraded in order');
    assert.strictEqual(report.halted, false, 'no halt');
    assert.deepEqual(report.failed, [], 'no failures');

    for (const n of names)
      assert.strictEqual(
        await ops.call(n, 'greeter.sys.version'),
        '2.0.0',
        `${n} is running the new version`,
      );
    ops.stop();
    nodes.forEach((n) => n.stop());
  });

  test('HALTS at the first bad target, leaving the rest on the old code', async (assert) => {
    const hub = Node.memoryHub();
    const ops = Node.start('ops@ru', hub.transport());
    // a and c host the unit; the middle target 'ghost@ru' does NOT — its upgrade call fails.
    const a = Node.start('a@ru', hub.transport());
    const ghost = Node.start('ghost@ru', hub.transport()); // no 'greeter' unit
    const c = Node.start('c@ru', hub.transport());
    Node.genServer(a, 'greeter', v1());
    Node.genServer(c, 'greeter', v1());
    await settle();

    const report = await rollingUpgrade({
      node: ops,
      unit: 'greeter',
      url: V2_URL,
      version: '2.0.0',
      targets: ['a@ru', 'ghost@ru', 'c@ru'], // ghost is the canary that goes bad
    });
    assert.deepEqual(report.upgraded, ['a@ru'], 'only the target before the failure upgraded');
    assert.strictEqual(report.halted, true, 'the rollout halted');
    assert.strictEqual(report.failed[0].target, 'ghost@ru', 'the failing target is recorded');
    assert.strictEqual(
      await ops.call('c@ru', 'greeter.sys.version'),
      '1.0.0',
      'the untouched target stayed on the old version',
    );
    ops.stop();
    a.stop();
    ghost.stop();
    c.stop();
  });
});
