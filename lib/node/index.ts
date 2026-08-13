// Barrel for the Node leg: import * as Node from '.../lib/node/index.ts'.
// Elixir's Node module, JS-shaped: Node.start(name, transport), Node.memoryHub(),
// Node.fromPort(worker). Message passing (call/cast/handle) replaces remote spawns —
// JS cannot ship closures — and the Failure envelope codec keeps channel identity across
// every hop: declared failures arrive declared, never as clone-gutted Errors.
export {
  start,
  heartbeat,
  memoryHub,
  fromPort,
  type Frame,
  type Transport,
  type NodeHandle,
} from './node.ts';

// The socket wire: universal (native WebSocket). The default codec is binary — tagged,
// length-prefixed, ETF-in-spirit (Erlang never base64s its distribution); jsonCodec is the
// devtools-readable reference. The relay hub lives in ./hub.ts, deliberately OUTSIDE this
// barrel: it stands on the `ws` package, and the barrel stays browser-safe.
export { wsTransport, traceTransport, binaryCodec, jsonCodec, type Codec } from './ws.ts';

// Rendezvous (HRW) hashing: pick THE owner of a key with minimal reshuffling on membership
// change — the routing primitive for distributed stateful entities (see examples/realtime-chat).
export { rendezvous } from './rendezvous.ts';

// Hot code upgrades: Erlang's release mechanics on web standards — import() as the code
// server, run-to-completion as suspend/resume, codeChange as code_change/3, and the
// `<name>.sys.upgrade` subject as the relup that reaches remote nodes.
export { serve, memoryStore, type Behavior, type Served, type Store } from './upgradable.ts';
