// The user-facing side — how a gateway node (the thing a browser/websocket connects to) talks
// to rooms it does not host. It never needs to know WHERE a room lives: the Registry answers
// that. The one subtlety is the COLD path (room not yet started), solved by a deterministic
// hash so concurrent "create lobby" requests all reach the same host — making find-or-start
// race-free without any distributed lock.
import type { NodeHandle } from '../../../lib/node/index.ts';
import type { ChatMessage } from './room-behavior.ts';

// djb2 — a tiny stable string hash. Deterministic host selection is the whole trick: every
// node hashes a key to the SAME host, so the cold-start of a room serialises on one node.
function hashKey(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = (h * 33) ^ key.charCodeAt(i);
  return h >>> 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureRoom(node: NodeHandle, key: string): Promise<string> {
  const known = node.whereis('rooms', key);
  if (known) return known; // hot path: the Registry already knows the owner
  const hosts = node.groupMembers('room-hosts').sort();
  if (hosts.length === 0) throw new Error('no room hosts available');
  const host = hosts[hashKey(key) % hosts.length]; // deterministic → race-free cold start
  await node.call(host, 'host.ensureRoom', { key }); // that host starts + registers the room
  for (let i = 0; i < 100 && !node.whereis('rooms', key); i++) await sleep(5); // await registry gossip
  const owner = node.whereis('rooms', key);
  if (!owner) throw new Error(`room ${key} did not register`);
  return owner;
}

// A room handle for one user on one gateway node. Every method resolves the owner (fast, via
// the Registry) and routes there with `via:rooms/<key>` — the ONE owner, wherever it lives.
export function chat(node: NodeHandle, key: string) {
  const via = `via:rooms/${key}`;
  const subject = (verb: string) => `room:${key}.${verb}`;
  return {
    async join(user: string): Promise<{ members: string[]; recent: ChatMessage[] }> {
      await ensureRoom(node, key);
      return node.call(via, subject('join'), user);
    },
    say(user: string, text: string): Promise<ChatMessage> {
      return node.call(via, subject('message'), { user, text });
    },
    history(): Promise<ChatMessage[]> {
      return node.call(via, subject('history'));
    },
    async leave(user: string): Promise<void> {
      const { remaining } = await node.call<{ remaining: number }>(via, subject('leave'), user);
      if (remaining === 0) {
        const owner = node.whereis('rooms', key);
        if (owner) node.cast(owner, 'host.closeRoom', { key }); // GC the empty room
      }
    },
  };
}
