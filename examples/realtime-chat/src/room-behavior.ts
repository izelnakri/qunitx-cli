// A chat room as a STATEFUL actor — the thing DynamicSupervisor + Registry exist for. Each
// room is a serve()d unit: its mailbox serializes every join/leave/message, so its member set
// and recent-history are mutated one message at a time, no locks, no races (gen_server state).
// One room = one supervised process, spawned on demand, addressable by key. This is exactly
// the Phoenix Channels shape, in this library's primitives.
import type { Behavior } from '../../../lib/node/index.ts';

export type ChatMessage = { user: string; text: string; at: number };
type RoomState = { members: Set<string>; recent: ChatMessage[] };

export function makeRoomBehavior(): Behavior<RoomState> {
  return {
    version: '1.0.0',
    init: () => ({ members: new Set(), recent: [] }),
    handlers: {
      join: (state, user) => {
        state.members.add(user as string);
        return { state, reply: { members: [...state.members], recent: state.recent } };
      },
      leave: (state, user) => {
        state.members.delete(user as string);
        return { state, reply: { remaining: state.members.size } }; // 0 → the host may close the room
      },
      message: (state, payload) => {
        const { user, text } = payload as { user: string; text: string };
        const message: ChatMessage = { user, text, at: Date.now() };
        state.recent = [...state.recent, message].slice(-50); // keep the last 50
        return { state, reply: message };
      },
      history: (state) => ({ state, reply: state.recent }),
      members: (state) => ({ state, reply: [...state.members] }),
    },
  };
}
