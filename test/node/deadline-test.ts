import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { Failure } from '../../lib/result/index.ts';
import type { Any as AnyFailure } from '../../lib/result/failure.ts';

module('Node | deadline propagation', () => {
  test('a nested call inherits the ROOT budget — capped, not the default 5s', async (assert) => {
    const hub = Node.memoryHub();
    const gw = Node.start('gw@dl', hub.transport());
    const a = Node.start('a@dl', hub.transport());
    const b = Node.start('b@dl', hub.transport());
    let deadlineAtA = 0;
    let deadlineAtB = 0;
    b.handle('leaf', (_p, _f, meta) => ((deadlineAtB = meta!.deadline!), 'ok'));
    a.handle('mid', (_p, _f, meta) => {
      deadlineAtA = meta!.deadline!;
      return a.call('b@dl', 'leaf'); // nested with DEFAULT timeout — must be capped by the root
    });

    const before = Date.now();
    await gw.call('a@dl', 'mid', undefined, 300);
    // The ~300ms root budget crossed the wire — NOT a fresh 5s default (a loaded runner may add
    // scheduling slack between `before` and the call, so the bound is generous but still << 5s).
    assert.true(
      deadlineAtA < before + 2000,
      'the first hop carries the root budget, not the default',
    );
    assert.true(deadlineAtB <= deadlineAtA, "the nested hop's deadline never exceeds its parent's");
    assert.true(
      deadlineAtB < before + 1000,
      `the nested default 5s was capped to the root budget (${deadlineAtB - before}ms)`,
    );
    gw.stop();
    a.stop();
    b.stop();
  });

  test('a spent budget fails FAST in an async continuation — the next hop is never called', async (assert) => {
    const hub = Node.memoryHub();
    const gw = Node.start('gw@dl', hub.transport());
    const a = Node.start('a@dl', hub.transport());
    const b = Node.start('b@dl', hub.transport());
    let leafCalls = 0;
    b.handle('leaf', () => (++leafCalls, 'ok'));
    let nestedRejection: unknown;
    a.handle('mid', async (_p, _f, meta) => {
      await new Promise((r) => setTimeout(r, 120)); // burn past the root's 50ms budget
      // withTrace carries the WHOLE meta (trace + deadline) across the async gap.
      nestedRejection = await a
        .withTrace(meta, () => a.call('b@dl', 'leaf'))
        .then(
          () => null,
          (e) => e,
        );
      return 'done';
    });

    await gw.call('a@dl', 'mid', undefined, 50).catch(() => {}); // the root times out — expected
    await new Promise((r) => setTimeout(r, 200)); // let the handler finish its doomed work
    assert.true(
      Failure.is(nestedRejection) && (nestedRejection as AnyFailure).code === 'DeadlineExceeded',
      'the nested call failed fast with DeadlineExceeded',
    );
    assert.equal(leafCalls, 0, 'the doomed downstream hop was NEVER invoked');
    gw.stop();
    a.stop();
    b.stop();
  });

  test('the callee sheds a call that ARRIVES past its deadline — the handler never runs', async (assert) => {
    const inner = Node.memoryHub();
    // A transport that delays delivery of call frames — the queue-lag scenario.
    const laggy = {
      transport() {
        const t = inner.transport();
        return {
          send(f: Node.Frame) {
            if (f.kind === 'call') setTimeout(() => t.send(f), 80);
            else t.send(f);
          },
          onFrame: (h: (f: Node.Frame) => void) => t.onFrame(h),
          close: t.close,
        };
      },
    };
    const a = Node.start('a@shed', laggy.transport());
    const b = Node.start('b@shed', inner.transport());
    let ran = 0;
    b.handle('work', () => (++ran, 'done'));
    await new Promise((r) => setTimeout(r, 30));

    const rejection = await a.call('b@shed', 'work', undefined, 40).then(
      () => null,
      (e) => e,
    );
    await new Promise((r) => setTimeout(r, 150)); // the delayed frame lands — after the deadline
    assert.equal(ran, 0, 'the callee shed the doomed call — no wasted work');
    assert.true(Failure.is(rejection), 'the caller saw a declared failure');
    a.stop();
    b.stop();
  });
});
