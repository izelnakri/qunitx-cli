# Realtime chat — the stateful-entity pattern

Where the ledger example was **stateless** (every request independent, actors only for
background work), this one is **stateful per entity**: a chat room is a live thing with member
state and history, and messages must route to _the one_ actor that owns it. That is the half of
OTP the ledger doesn't touch, and it needs exactly two building blocks — **`DynamicSupervisor`**
(spawn a supervised process on demand) and **`Registry`** (find the process for a key). This
example is the smallest honest demonstration of the pair. Run it:

```bash
node src/demo.ts   # two hosts + two gateways in one process, over an in-process hub
```

## 1. The shape

| Node role                               | What it is                   | Holds                                                               |
| --------------------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| **room host** (`room-host.ts`)          | where rooms live             | a `DynamicSupervisor` of room actors + their `Registry` entries     |
| **room actor** (`room-behavior.ts`)     | one `serve()`d unit per room | `{ members, recent }`, mutated one message at a time by its mailbox |
| **gateway** (a browser/websocket front) | where users connect          | nothing — it routes to rooms it doesn't host                        |

A room is a **stateful actor**: its mailbox serializes every join/leave/message, so its member
set and history change one event at a time — no locks, no races (gen_server state). One room =
one supervised process, spawned on demand, addressable by key. This is the Phoenix Channels
shape in this library's primitives.

## 2. The one pattern to learn: find-or-start

The whole example turns on how a gateway reaches a room it may not have started yet
(`chat-client.ts`):

```
join("lobby"):
  owner = whereis("rooms", "lobby")          # HOT path: the Registry knows → done
  if not owner:                              # COLD path: the room doesn't exist yet
    host = hosts[ hash("lobby") % hosts ]    # deterministic → all callers pick the SAME host
    call(host, "host.ensureRoom", {lobby})   # that host DynamicSupervisor.start_child's it
                                             #   and Registry.register's the key
    wait for whereis("rooms","lobby")         # the registration gossips to every node
  call("via:rooms/lobby", ...)               # route to THE owner, wherever it lives
```

Two design choices make this correct and simple:

- **`Registry` gives single-owner routing.** `call('via:rooms/lobby', ...)` resolves the _one_
  node that owns key `lobby` and routes there — unlike a process **group** (`group:`), which
  round-robins _many_ members. Groups are for services (any worker will do); the Registry is
  for entities (there is exactly one #lobby).
- **A deterministic hash makes cold-start race-free without a lock.** Every gateway hashes
  `"lobby"` to the _same_ host, so two users creating #lobby simultaneously both hit one host,
  whose local `start_child` check serializes them. No distributed coordination, no double room.
  Once started, the `Registry` publishes the owner and the hash path is never taken again.

`DynamicSupervisor` + `Registry` are the pair: the supervisor _starts and keeps alive_ the room
process; the registry _finds_ it by key. Elixir builds stateful systems this way (Registry +
DynamicSupervisor is the textbook combination); this is the same, on web-standard transports.

## 3. Lifecycle — spawn and reap

- **Spawn on demand**: the first `join` for a key `start_child`s the room (`restart: 'transient'`)
  and registers it. A room that _crashes_ is restarted fresh under the same key (transient); a
  room that _exits cleanly_ is not.
- **Reap when empty**: when the last member `leave`s, the gateway casts `host.closeRoom`, which
  `terminate_child`s the room (a clean exit → no restart) and `unregister`s the key. Rooms cost
  nothing when idle. (`demo.ts` shows `whereis` going `null` after the room empties.)

## 4. Distribution and the honest limitations

Run the demo and you'll see #lobby and #random land on _different_ hosts by hash, both gateways
agreeing on where each lives, and one actor serializing a shared conversation. In production the
hosts and gateways are separate pods over a real hub (`wsTransport` + `hub.ts`) — the code is
identical; only the transport changes.

Two limitations are deliberate and worth stating (they're where a production system adds work,
and where Elixir's Horde/`:global` earn their complexity):

1. **In-memory room state dies with its host.** If a room host crashes, its rooms' member lists
   and history are gone; the next `join` re-creates the room (empty) on a surviving host — the
   `Registry` prunes the dead owner, the hash re-selects. Availability is preserved; _state_ is
   not. A real system persists room state (Postgres, like the ledger's checkpoints) or replicates
   it, so a restarted room rehydrates. The abstraction gives you the routing and supervision; the
   durability is your call.
2. **No rebalancing when the host set changes.** Adding/removing a host reshuffles the hash for
   _new_ rooms only; existing rooms stay put (their `Registry` entry still routes correctly). This
   is fine and simple; consistent-hashing with handoff (Horde) is the next step if you need
   even load after scale events.

Neither is a gap in the abstractions — they are the two decisions every distributed stateful
system must make, surfaced honestly instead of hidden.
