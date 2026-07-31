import { module, test } from 'qunitx';
import * as Node from '../../lib/node/index.ts';
import { reliablePubSub } from '../../lib/pubsub/index.ts';

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// A hub that can drop or duplicate specific frames, to exercise the reliability protocol.
function controllableHub() {
  const inner = Node.memoryHub();
  let drop: (f: Node.Frame) => boolean = () => false;
  let dup: (f: Node.Frame) => boolean = () => false;
  return {
    transport() {
      const t = inner.transport();
      return {
        send(f: Node.Frame) {
          if (drop(f)) return;
          t.send(f);
          if (dup(f)) t.send(f);
        },
        onFrame: (h: (f: Node.Frame) => void) => t.onFrame(h),
        close: t.close,
      };
    },
    drop: (fn: (f: Node.Frame) => boolean) => (drop = fn),
    dup: (fn: (f: Node.Frame) => boolean) => (dup = fn),
  };
}
const seqOf = (f: Node.Frame) => (f.payload as { seq?: number } | undefined)?.seq;

module('PubSub | reliable delivery', () => {
  test('a gap is recovered by replay and delivered IN ORDER', async (assert) => {
    const hub = controllableHub();
    const a = Node.start('a@rps', hub.transport());
    const b = Node.start('b@rps', hub.transport());
    const rpsA = reliablePubSub(a, { heartbeatMs: false });
    const rpsB = reliablePubSub(b, { heartbeatMs: false });
    const got: number[] = [];
    rpsB.subscribe('t', (_e, p) => got.push(p as number));
    await settle();

    let dropped = false; // drop the FIRST transmission of seq 2 only
    hub.drop((f) => f.subject === 'rps.msg' && seqOf(f) === 2 && !dropped && (dropped = true));
    rpsA.broadcast('t', 'e', 1);
    rpsA.broadcast('t', 'e', 2); // lost in flight
    rpsA.broadcast('t', 'e', 3); // reveals the gap → triggers replay of 2
    await settle();
    assert.deepEqual(got, [1, 2, 3], 'the dropped message was replayed and reordered');
    a.stop();
    b.stop();
  });

  test('a duplicated message is de-duplicated', async (assert) => {
    const hub = controllableHub();
    const a = Node.start('a@rps', hub.transport());
    const b = Node.start('b@rps', hub.transport());
    const rpsA = reliablePubSub(a, { heartbeatMs: false });
    const rpsB = reliablePubSub(b, { heartbeatMs: false });
    const got: number[] = [];
    rpsB.subscribe('t', (_e, p) => got.push(p as number));
    await settle();

    hub.dup((f) => f.subject === 'rps.msg' && seqOf(f) === 1); // deliver seq 1 twice
    rpsA.broadcast('t', 'e', 1);
    rpsA.broadcast('t', 'e', 2);
    await settle();
    assert.deepEqual(got, [1, 2], 'the duplicate seq was ignored');
    a.stop();
    b.stop();
  });

  test('a lost TAIL message is recovered by the heartbeat', async (assert) => {
    const hub = controllableHub();
    const a = Node.start('a@rps', hub.transport());
    const b = Node.start('b@rps', hub.transport());
    const rpsA = reliablePubSub(a, { heartbeatMs: 25 });
    const rpsB = reliablePubSub(b, { heartbeatMs: 25 });
    const got: number[] = [];
    rpsB.subscribe('t', (_e, p) => got.push(p as number));
    await settle();

    let dropped = false; // drop seq 2 with nothing after it — only the heartbeat can reveal it
    hub.drop((f) => f.subject === 'rps.msg' && seqOf(f) === 2 && !dropped && (dropped = true));
    rpsA.broadcast('t', 'e', 1);
    rpsA.broadcast('t', 'e', 2); // lost tail
    await settle(150); // let a heartbeat fire → gap detected → replay
    assert.deepEqual(got, [1, 2], 'the heartbeat detected the missing tail and replayed it');
    a.stop();
    b.stop();
  });

  test('send-state is GC-ed for an idle, unsubscribed topic — delivery still works after', async (assert) => {
    let clock = 1000;
    const node = Node.start('n@rps', Node.memoryHub().transport());
    const rps = reliablePubSub(node, { heartbeatMs: 10, staleTopicMs: 50, now: () => clock });

    rps.broadcast('ephemeral', 'e', 1); // creates send-state; no local subscriber
    clock += 200; // idle past staleTopicMs
    await settle(40); // let the heartbeat sweep GC it

    // Re-publish: seq restarts (send-state was reclaimed). A fresh subscriber still receives it.
    const got: number[] = [];
    rps.subscribe('ephemeral', (_e, p) => got.push(p as number));
    rps.broadcast('ephemeral', 'e', 2);
    await settle(20);
    assert.deepEqual(got, [2], 'GC of idle send-state does not break subsequent delivery');
    node.stop();
  });
});
