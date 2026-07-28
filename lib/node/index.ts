// Barrel for the Node leg: import * as Node from '.../lib/node/index.ts'.
// Elixir's Node module, JS-shaped: Node.start(name, transport), Node.memoryHub(),
// Node.fromPort(worker). Message passing (call/cast/handle) replaces remote spawns —
// JS cannot ship closures — and the Failure envelope codec keeps channel identity across
// every hop: declared failures arrive declared, never as clone-gutted Errors.
export { start, memoryHub, fromPort, type Frame, type Transport, type NodeHandle } from './node.ts';
