/**
 * `meshTransport` — a {@link Transport} that talks **directly to peers** instead of through a
 * relay {@link memoryHub}. The shipped hub is a single relay: every inter-node frame transits it,
 * so it's a throughput bottleneck and a single point of failure. A mesh removes that — each node
 * holds one link per peer and routes a directed frame straight to its target, broadcasting only
 * true gossip. Because the `Node` core is transport-agnostic, this is a drop-in: `call`/`cast`/
 * `via` don't change, only what carries the frames.
 *
 * The routing is universal and injectable: you supply peer discovery (`peers`, e.g. from
 * {@link cluster}) and a `link` factory that opens one bidirectional {@link MeshLink} to a peer
 * (a WebSocket in production, an in-memory channel in tests). The transport maintains links as
 * peers come and go, sends a frame with a `to` on that peer's link, and broadcasts a frame without
 * one to every link.
 *
 * ```ts
 * import { Node } from './node.ts';
 * const net = meshNetwork(['a@mesh', 'b@mesh']);
 * const a = Node.start('a@mesh', meshTransport('a@mesh', net.for('a@mesh')));
 * const b = Node.start('b@mesh', meshTransport('b@mesh', net.for('b@mesh')));
 * b.handle('add', (p) => (p as number[]).reduce((x, y) => x + y, 0));
 * await a.call('b@mesh', 'add', [2, 3]); // 5 — routed peer-to-peer, no hub
 * a.stop();
 * b.stop();
 * ```
 */
import type { Transport, Frame } from './node.ts';
import { binaryCodec, type Codec } from './ws.ts';

/** One bidirectional link to a single peer — a WebSocket in prod, an in-memory channel in tests. */
export interface MeshLink {
  /** Send a frame to the peer at the other end. */
  send(frame: Frame): void;
  /** Register the inbound-frame handler for this link. */
  onFrame(handler: (frame: Frame) => void): void;
  /** Reports the link dying (socket close/error), if the link can tell — the transport re-dials. */
  onDown?(handler: () => void): void;
  /** Tear the link down. */
  close(): void;
}

/**
 * Build a mesh {@link Transport} for `self`. `peers()` reports who should be linked (poll it from
 * {@link cluster}); `link(peer)` opens one {@link MeshLink}. Directed frames route to one peer;
 * frames without a `to` broadcast to every link.
 *
 * ```ts
 * const net = meshNetwork();
 * const t = meshTransport('n@1', net.for('n@1'));
 * typeof t.send; // 'function'
 * t.close?.();
 * ```
 */
export function meshTransport(
  self: string,
  options: {
    peers: () => Iterable<string>;
    link: (peer: string) => MeshLink;
    pollMs?: number;
    /**
     * Epidemic gossip: broadcast to only this many RANDOM peers, each of whom relays onward
     * (deduplicated by id, bounded by a hop TTL) — the sender pays O(k) instead of O(N) per
     * broadcast, at the price of a couple of relay hops of latency. Off by default (send-all),
     * which is optimal for small meshes; turn it on past a few dozen peers.
     */
    gossipFanout?: number;
  },
): Transport {
  const links = new Map<string, MeshLink>();
  const reopenCbs = new Set<() => void>();
  let inbound: (frame: Frame) => void = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let started = false;

  // Gossip dedup: remember recent ids so a relayed copy is never delivered or re-relayed twice.
  const seen = new Set<string>();
  const remember = (id: string): void => {
    seen.add(id);
    if (seen.size > 4096) for (const old of seen) if (seen.size > 2048) seen.delete(old);
  };
  let gossipCounter = 0;
  const relay = (frame: Frame): void => {
    const k = options.gossipFanout!;
    const candidates = [...links.values()];
    // k random links, partial Fisher–Yates.
    for (let i = 0; i < Math.min(k, candidates.length); i++) {
      const j = i + Math.floor(Math.random() * (candidates.length - i));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      candidates[i].send(frame);
    }
  };

  const sync = (): void => {
    const want = new Set(options.peers());
    want.delete(self);
    let grew = false;
    for (const peer of want) {
      if (links.has(peer)) continue;
      const link = options.link(peer);
      link.onFrame((frame) => inbound(frame)); // fan every link's inbound into the node
      link.onDown?.(() => links.delete(peer)); // a dead link is forgotten — the next poll re-dials
      links.set(peer, link);
      grew = true;
    }
    for (const [peer, link] of [...links]) {
      if (!want.has(peer)) {
        link.close();
        links.delete(peer);
      }
    }
    // A link that appeared AFTER start is a (re)connection: let the node re-announce itself
    // (hello + full CRDT state), so late-discovered peers converge — hellos are idempotent.
    if (grew && started) for (const cb of reopenCbs) queueMicrotask(cb);
  };

  return {
    send(frame) {
      if (frame.to !== undefined) {
        const link = links.get(frame.to);
        if (link) link.send(frame);
        else for (const link of links.values()) link.send(frame); // pre-discovery fallback
      } else if (
        options.gossipFanout &&
        links.size > options.gossipFanout &&
        frame.kind !== 'hello' &&
        frame.kind !== 'bye'
      ) {
        // Epidemic broadcast: k random peers, who relay onward. TTL sized so k-ary spread
        // covers the mesh with headroom; dedup makes redundant arrivals harmless. hello/bye are
        // EXEMPT: they are rare one-shot LIVENESS announcements, and a missed hello hides a
        // peer's facts forever (anti-entropy heals facts, not liveness) — so the control plane
        // always goes to every link; fan-out only thins the chatty data plane.
        const ttl = Math.ceil(Math.log(links.size + 1) / Math.log(options.gossipFanout + 1)) + 2;
        const id = `${self}:${++gossipCounter}`;
        remember(id); // never re-deliver my own broadcast to myself
        relay({ ...frame, gossip: { id, ttl } });
      } else {
        for (const link of links.values()) link.send(frame); // gossip to all — small-mesh default
      }
    },
    onFrame(handler) {
      inbound = (frame) => {
        if (frame.gossip) {
          if (seen.has(frame.gossip.id)) return; // already delivered here — drop the copy
          remember(frame.gossip.id);
          if (frame.gossip.ttl > 1 && options.gossipFanout)
            relay({ ...frame, gossip: { id: frame.gossip.id, ttl: frame.gossip.ttl - 1 } });
        }
        handler(frame);
      };
      sync();
      started = true;
      timer = setInterval(sync, options.pollMs ?? 1000);
      (timer as { unref?: () => void }).unref?.();
    },
    onReopen(cb) {
      reopenCbs.add(cb);
    },
    close() {
      if (timer) clearInterval(timer);
      for (const link of links.values()) link.close();
      links.clear();
    },
  };
}

/**
 * Dial one mesh peer over a native `WebSocket` (a web standard — universal, no dependency):
 * frames ride `codec` (binary by default), sends buffer until the socket opens, and a
 * close/error reports {@link MeshLink.onDown} so the transport re-dials on its next poll. The
 * listening side is Node-only and lives in `./mesh-ws.ts` (outside the barrel, like the hub).
 *
 * ```ts
 * typeof webSocketMeshLink; // 'function'
 * ```
 */
export function webSocketMeshLink(url: string, codec: Codec = binaryCodec): MeshLink {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const backlog: (string | Uint8Array)[] = [];
  const downCbs = new Set<() => void>();
  let down = false;
  const reportDown = (): void => {
    if (down) return;
    down = true;
    for (const cb of downCbs) cb();
  };
  socket.addEventListener('open', () => {
    for (const data of backlog.splice(0)) socket.send(data);
  });
  socket.addEventListener('close', reportDown);
  socket.addEventListener('error', reportDown);
  return {
    send(frame) {
      const data = codec.encode(frame);
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
      else if (socket.readyState === WebSocket.CONNECTING) backlog.push(data);
      // CLOSING/CLOSED: drop — onDown already told the transport to re-dial.
    },
    onFrame(handler) {
      socket.addEventListener('message', (event) => {
        const data = (event as MessageEvent).data;
        try {
          handler(
            codec.decode(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer)),
          );
        } catch {
          // not our wire — drop the frame
        }
      });
    },
    onDown(handler) {
      downCbs.add(handler);
    },
    close: () => socket.close(),
  };
}

/**
 * An in-process mesh network for tests and doctests — models one bidirectional channel per pair of
 * nodes, so `meshTransport` can be exercised with real per-peer routing and no central relay.
 * `net.for(name)` yields the `{ peers, link }` options for that node.
 *
 * ```ts
 * const net = meshNetwork(['a@n', 'b@n']);
 * const opts = net.for('a@n');
 * [...opts.peers()]; // ['a@n', 'b@n']
 * ```
 */
export function meshNetwork(members: string[] = []): {
  for(self: string): { peers: () => Iterable<string>; link: (peer: string) => MeshLink };
} {
  const roster = new Set(members);
  // One channel per unordered pair; each side buffers until its peer wires a handler.
  const ends = new Map<string, { handler?: (f: Frame) => void; buffer: Frame[] }>();
  const endKey = (from: string, to: string) => `${from} ${to}`;
  const endFor = (from: string, to: string) => {
    const k = endKey(from, to);
    let end = ends.get(k);
    if (!end) ends.set(k, (end = { buffer: [] }));
    return end;
  };

  return {
    for(self) {
      roster.add(self);
      return {
        peers: () => roster,
        link: (peer) => {
          roster.add(peer);
          const mine = endFor(self, peer); // where the peer delivers to me
          return {
            send(frame) {
              const theirs = endFor(peer, self); // where I deliver to the peer
              if (theirs.handler) theirs.handler(frame);
              else theirs.buffer.push(frame);
            },
            onFrame(handler) {
              mine.handler = handler;
              for (const frame of mine.buffer.splice(0)) handler(frame);
            },
            close() {
              mine.handler = undefined;
            },
          };
        },
      };
    },
  };
}
