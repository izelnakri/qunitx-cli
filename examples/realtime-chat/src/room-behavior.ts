// A chat room as a STATEFUL, DURABLE actor. Its mailbox serializes every join/leave/message,
// so member list and history change one event at a time (gen_server state) — and because the
// host serves it with a `store`, every mutating message is persisted BEFORE its ack, so a room
// survives its host dying and rehydrates on the next owner (README §4).
//
// State is JSON-safe (arrays, not Sets) so it round-trips through a real store (Postgres).
import type { Behavior } from '../../../lib/node/index.ts';

export type ChatMessage = { user: string; text: string; at: number };
type RoomState = { members: string[]; recent: ChatMessage[] };

export function makeRoomBehavior(): Behavior<RoomState> {
  return {
    version: '1.0.0',
    init: () => ({ members: [], recent: [] }),
    handlers: {
      // Mutating handlers return NEW state (immutable) and persist by default (before ack).
      join: (state, user) => {
        const members = state.members.includes(user as string)
          ? state.members
          : [...state.members, user as string];
        return { state: { ...state, members }, reply: { members, recent: state.recent } };
      },
      leave: (state, user) => {
        const members = state.members.filter((m) => m !== user);
        return { state: { ...state, members }, reply: { remaining: members.length } };
      },
      message: (state, payload) => {
        const { user, text } = payload as { user: string; text: string };
        const message: ChatMessage = { user, text, at: Date.now() };
        return {
          state: { ...state, recent: [...state.recent, message].slice(-50) },
          reply: message,
        };
      },
      // Reads change nothing — persist:false skips the durable write.
      history: (state) => ({ state, reply: state.recent, persist: false }),
      members: (state) => ({ state, reply: state.members, persist: false }),
    },
  };
}
