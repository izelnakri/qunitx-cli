import { module, test } from 'qunitx';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore } from '../../lib/node/file-store.ts';
import { start, memoryHub } from '../../lib/node/index.ts';
import { raftStore } from '../../lib/jobs/index.ts';

const until = async (cond: () => boolean, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return cond();
};

module('Node | fileStore (disk durability, no DB)', () => {
  test('save/load/clear round-trip; survives a fresh instance (a process restart)', async (assert) => {
    const dir = await mkdtemp(join(tmpdir(), 'qunitx-filestore-'));
    try {
      const a = fileStore(dir);
      await a.save('room:lobby', { members: ['ada'] });
      assert.deepEqual(
        await a.load('room:lobby'),
        { members: ['ada'] },
        'round-trips through disk',
      );
      assert.equal(await a.load('missing'), undefined, 'a missing key reads as undefined');

      // a NEW instance on the same dir sees the persisted data — the "restart" survives
      const restarted = fileStore(dir);
      assert.deepEqual(
        await restarted.load('room:lobby'),
        { members: ['ada'] },
        'durable across instances — this is what a process restart would read',
      );

      await restarted.clear('room:lobby');
      assert.equal(await fileStore(dir).load('room:lobby'), undefined, 'clear removes it durably');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('raftStore persists its log/snapshot to disk via fileStore', async (assert) => {
    const dir = await mkdtemp(join(tmpdir(), 'qunitx-raftfile-'));
    const hub = memoryHub();
    const node = start('n@rf', hub.transport());
    const store = raftStore(node, {
      peers: ['n@rf'],
      persistence: fileStore(dir),
      electionTimeoutMs: () => 15,
    });
    try {
      assert.true(
        await until(() => store.raft.leader() !== null),
        'the single-member group elected',
      );
      await store.save('k', { v: 42 });
      assert.deepEqual(await store.load('k'), { v: 42 }, 'raftStore round-trips a value');
      assert.true(
        (await readdir(dir)).length > 0,
        'Raft wrote its state to disk — the cluster survives a full restart, not just a minority',
      );
    } finally {
      store.stop();
      node.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
