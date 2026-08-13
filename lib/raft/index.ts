// Barrel for the Raft leg: import * as Raft from '.../lib/raft/index.ts'.
//
// CP consensus (Erlang `ra`'s role): a replicated log where commands commit only on a MAJORITY
// and apply in the same order everywhere — a minority partition can never decide. The complement
// to the AP/CRDT layer: use a Raft group for the few linearizable decisions (a lock, a lease, a
// unique sequence), the AP layer for everything that should stay available under partition.
export { raft, type Raft, type RaftRole, type LogEntry } from './raft.ts';
