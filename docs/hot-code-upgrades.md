# Hot code upgrades, for the Node.js/Deno developer

How Erlang ships new code into a RUNNING system without dropping a request — and how the same
mechanics work here, on web standards, in Node.js, Deno, and the browser.

## 1. What Erlang actually does (the five mechanics)

1. **The code server keeps two versions of a module.** Processes executing old code finish on
   it; the next fully-qualified call lands in the new version.
2. **Suspend → swap → resume.** The release handler suspends a process _between messages_,
   swaps the module, resumes. No message is ever half-processed by two versions.
3. **`code_change/3`.** The NEW module receives the old state and the old version, and returns
   the migrated state — the new code knows how to read its ancestors' data.
4. **The relup.** A release upgrade script walks the supervision tree across every node,
   applying 1–3 in dependency order.
5. **Downgrades are the same road driven backwards** — `code_change` is told which way.

## 2. The JS mapping (why this is natural, not forced)

| Erlang                    | this system                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| code server, two versions | module versions are **URLs**; `import(url)` loads the next one                                       |
| suspend between messages  | **free** — JS run-to-completion: a handler runs atomically, so a swap can only land between messages |
| `code_change/3`           | `codeChange(fromVersion, oldState)` on the incoming `Behavior`                                       |
| relup across nodes        | `call(peer, '<name>.sys.upgrade', { url })` — an ordinary cluster call                               |
| downgrade                 | the same call, pointed at the older version's URL                                                    |

Two of Erlang's hardest tricks are _web platform defaults_ here: dynamic `import()` is the code
server, and the event loop's run-to-completion is the suspension. What Erlang has that no JS
runtime gives you: swapping the VM itself. A Node/Deno/browser _runtime_ upgrade still needs a
rolling restart — that is the honest boundary of this document.

## 3. The distributed Hello World, step by step

**Step 1 — the hub** (epmd + mesh + nodedown, one terminal):

```ts
// hub-boot.ts — node hub-boot.ts
import { startHub } from './lib/node/hub.ts';
startHub({ port: 4369 });
```

**Step 2 — the service node** (second terminal; Deno on purpose, to show it does not matter):

```ts
// greeter.ts — deno run --allow-net greeter.ts
import * as Node from './lib/node/index.ts';

const svc = Node.start('svc@cluster', Node.wsTransport('ws://localhost:4369'));
Node.serve(svc, 'greeter', {
  version: '1.0.0',
  init: () => ({ greeted: 0 }),
  handlers: {
    hello: (state, name) => ({ state: { greeted: state.greeted + 1 }, reply: `Hello ${name}` }),
  },
});
```

**Step 3 — a client node** (third terminal, Node.js):

```ts
// ops.ts — node ops.ts
import * as Node from './lib/node/index.ts';
const ops = Node.start('ops@cluster', Node.wsTransport('ws://localhost:4369'));
await new Promise((r) => setTimeout(r, 300));
console.log(await ops.call('svc@cluster', 'greeter.hello', 'ada')); // Hello ada
console.log(await ops.call('svc@cluster', 'greeter.sys.version')); // 1.0.0
```

**Step 4 — write v2 as a module.** This is the "release": a default-exported `Behavior` at a
URL every node can import (an https:// CDN path in production; a file path in dev):

```ts
// greeter-v2.ts — served at https://cdn.example.com/greeter-v2.ts
export default {
  version: '2.0.0',
  handlers: {
    hello: (state, name) => ({
      state: { greeted: state.greeted + 1 },
      reply: `Hallo ${name} #${state.greeted + 1}`,
    }),
    stats: (state) => ({ state, reply: state.greeted }), // a NEW capability
  },
  codeChange: (fromVersion, oldState) => ({ greeted: oldState.greeted }), // the count SURVIVES
};
```

**Step 5 — the relup, from the ops node, against the RUNNING service:**

```ts
await ops.call('svc@cluster', 'greeter.sys.upgrade', {
  url: 'https://cdn.example.com/greeter-v2.ts',
});
console.log(await ops.call('svc@cluster', 'greeter.hello', 'bo')); // Hallo bo #2  ← new code, OLD state
console.log(await ops.call('svc@cluster', 'greeter.stats')); // 2            ← new handler, live
```

No process restarted. Calls in flight during the swap completed on v1; the next message met
v2 holding the migrated state. For many service nodes, loop `list()` and upgrade one at a
time — that loop _is_ the relup script.

**Step 6 — the downgrade** is step 5 with v1's URL (its `codeChange` receives
`fromVersion: '2.0.0'` and reads back what it understands). Ship every version with a
`codeChange` that accepts its neighbors', and rollback is one call.

**Browser tab as a node:** identical — `Node.start('ui@cluster', Node.wsTransport('wss://…'))`
in a page; `import(url)` and run-to-completion are the same standards there, so a `sys.upgrade`
call hot-swaps code in a tab that never reloads.

## 4. The uptime arithmetic, honestly

Seven nines is ~3 seconds of downtime a year — no _deploy_ strategy alone gets you there;
what gets you close is removing deploys from the downtime budget entirely, which is exactly
what this mechanism does for application code:

- **Code changes** (the overwhelming majority of deploys): hot swap, zero dropped requests.
- **State-shape changes**: hot swap + `codeChange`, still zero.
- **Runtime/OS upgrades**: rolling restarts behind the hub — callers see `CallTimeout`/nodedown
  for one peer while others answer; pair with `Supervisor` (restart the node's workers) and
  `retry` on callers, and the _cluster_ never stops answering even though individual runtimes do.
- **The hub itself** is the remaining single point — run two hubs and dial both transports, or
  put the hub behind the same rolling discipline. (Erlang has the same story: epmd dies too.)

The system's failure vocabulary threads through all of it: an upgrade that throws inside
`codeChange` rejects the `sys.upgrade` call as a declared `RemoteCrash` — the old version keeps
serving, and the operator got a typed answer instead of a dead node.
