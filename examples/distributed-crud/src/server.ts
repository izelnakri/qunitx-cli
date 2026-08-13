// A DISTRIBUTED CRUD web server — the classic REST shape (Express-look routes) in front of the
// distributed core, showing where each module earns its keep:
//
//   router (lib/router)      the stateless HTTP edge — same app object on Node and Deno
//   serve({via}) + Registry  one durable ACTOR per row: writes serialize through a single owner
//                            (no SELECT..FOR UPDATE races), reads hit in-memory state (a cache
//                            that can't go stale — the owner IS the writer)
//   Store seam               persist-before-ack; memoryStore in tests, postgresStore in prod
//                            (examples/realtime-chat/src/store-postgres.ts — identical seam)
//   rendezvous + hosts       rows spread across entity-host nodes; gateways stay stateless —
//                            scale reads/writes by adding hosts, scale HTTP by adding gateways
//   rateLimiter / Telemetry  429 past the budget; a span per request with the trace id
//
// The list index is itself an actor (eventually consistent on create/delete — stated); rows are
// strongly consistent through their single owner. That split is the honest distributed-CRUD
// design: entity truth is serialized, collection views converge.
import * as Node from '../../../lib/node/index.ts';
import { rendezvous, rateLimiter } from '../../../lib/node/index.ts';
import * as Supervisor from '../../../lib/supervisor/index.ts';
import * as Telemetry from '../../../lib/telemetry/index.ts';
import { router, json, type Router } from '../../../lib/router/index.ts';
import type { NodeHandle, Store, Behavior, RateLimiter } from '../../../lib/node/index.ts';

export type Todo = { id: string; title: string; done: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------- entity behaviors
// One actor per todo. Mutations persist BEFORE the ack (the store seam); reads skip the write.
function makeTodoBehavior(): Behavior<Todo | null> {
  return {
    version: '1.0.0',
    init: () => null,
    handlers: {
      put: (_state, todo) => ({ state: todo as Todo, reply: todo }),
      patch: (state, patch) => {
        if (!state) return { state, reply: null, persist: false };
        const next = { ...state, ...(patch as Partial<Todo>), id: state.id };
        return { state: next, reply: next };
      },
      get: (state) => ({ state, reply: state, persist: false }),
    },
  };
}

// The collection index — also an actor, so "list" is one call, not a table scan.
function makeIndexBehavior(): Behavior<string[]> {
  return {
    version: '1.0.0',
    init: () => [],
    handlers: {
      add: (state, id) => ({
        state: state.includes(id as string) ? state : [...state, id as string],
        reply: true,
      }),
      remove: (state, id) => ({ state: state.filter((x) => x !== id), reply: true }),
      list: (state) => ({ state, reply: state, persist: false }),
    },
  };
}

// ---------------------------------------------------------------------------------- entity host
/** A node that HOSTS row actors — add more of these to scale the data plane. */
export function startCrudHost(name: string, transport: Node.Transport, store: Store) {
  const node = Node.start(name, transport);
  node.join('crud-hosts');
  const units = Supervisor.dynamic({ maxRestarts: 50, maxSeconds: 10 });
  const live = new Map<string, { exit: () => void }>();

  const spawn = (unit: string, key: string, behavior: Behavior<unknown>, registry: string) => {
    if (live.has(unit)) return;
    live.set(unit, { exit: () => {} });
    units.startChild({
      id: unit,
      restart: 'transient',
      start: (signal) =>
        new Promise<void>((exited) => {
          const served = Node.genServer(node, unit, behavior, {
            via: { registry, key },
            store,
            storeKey: unit,
            maxMailbox: 256,
          });
          live.set(unit, served);
          signal.addEventListener('abort', () => {
            served.exit();
            live.delete(unit);
            exited();
          });
        }),
    });
  };

  node.handle('crud.ensureTodo', (payload) => {
    const id = (payload as { id: string }).id;
    spawn(`todo:${id}`, id, makeTodoBehavior() as Behavior<unknown>, 'todos');
    return name;
  });
  node.handle('crud.ensureIndex', () => {
    spawn('todos-index', 'todos', makeIndexBehavior() as Behavior<unknown>, 'indexes');
    return name;
  });
  node.handle('crud.removeTodo', async (payload) => {
    const id = (payload as { id: string }).id;
    await units.terminateChild(`todo:${id}`); // clean exit → unregisters the via key
    await store.clear(`todo:${id}`); // the row is gone durably, not just in memory
    return true;
  });

  return {
    node,
    stop: async () => {
      await units.stop();
      node.stop();
    },
  };
}

// ------------------------------------------------------------------------------------- gateway
// Find-or-start on the rendezvous host (the chat's race-free cold-start pattern, verbatim).
async function ensure(node: NodeHandle, subject: string, key: string, registry: string) {
  if (node.whereis(registry, key)) return;
  const host = rendezvous(key, node.groupMembers('crud-hosts'));
  if (!host) throw new Error('no crud hosts available');
  await node.call(host, subject, { id: key });
  for (let i = 0; i < 100 && !node.whereis(registry, key); i++) await sleep(5);
}
const ensureTodo = (node: NodeHandle, id: string) => ensure(node, 'crud.ensureTodo', id, 'todos');
const ensureIndex = async (node: NodeHandle) => {
  if (node.whereis('indexes', 'todos')) return;
  const host = rendezvous('todos-index', node.groupMembers('crud-hosts'));
  if (!host) throw new Error('no crud hosts available');
  await node.call(host, 'crud.ensureIndex', {});
  for (let i = 0; i < 100 && !node.whereis('indexes', 'todos'); i++) await sleep(5);
};

/** The Express-look app on a stateless gateway node — add more gateways to scale HTTP. */
export function crudApp(node: NodeHandle, options: { limiter?: RateLimiter } = {}): Router {
  const app = router();
  const limiter = options.limiter ?? rateLimiter({ capacity: 200, refillPerSec: 500 });

  // Load protection + observability on every request: 429 past the budget, a telemetry span
  // (start/stop + duration) a metrics sink can consume, correlated with the node-call traces.
  app.use((req, next) => {
    if (!limiter.tryAcquire()) return json({ error: 'rate limited' }, 429);
    return Telemetry.span(
      ['http', 'request'],
      { method: req.method, path: new URL(req.url).pathname },
      async () => ({ result: await next() }),
    );
  });

  app.get('/todos', async () => {
    await ensureIndex(node);
    const ids = await node.call<string[]>('via:indexes/todos', 'todos-index.list');
    const todos = await Promise.all(
      ids.slice(0, 50).map(async (id) => {
        await ensureTodo(node, id);
        return node.call<Todo | null>(`via:todos/${id}`, `todo:${id}.get`);
      }),
    );
    return json(todos.filter(Boolean));
  });

  app.post('/todos', async (req) => {
    const body = (await req.json()) as { title: string };
    const todo: Todo = { id: crypto.randomUUID().slice(0, 8), title: body.title, done: false };
    await ensureTodo(node, todo.id);
    await node.call(`via:todos/${todo.id}`, `todo:${todo.id}.put`, todo);
    await ensureIndex(node);
    node.cast('via:indexes/todos', 'todos-index.add', todo.id); // index converges async
    return json(todo, 201);
  });

  app.get('/todos/:id', async (req) => {
    const id = req.params.id;
    await ensureTodo(node, id); // cold start rehydrates from the shared store
    const todo = await node.call<Todo | null>(`via:todos/${id}`, `todo:${id}.get`);
    return todo ? json(todo) : json({ error: 'not found' }, 404);
  });

  app.patch('/todos/:id', async (req) => {
    const id = req.params.id;
    await ensureTodo(node, id);
    const patched = await node.call<Todo | null>(
      `via:todos/${id}`,
      `todo:${id}.patch`,
      await req.json(),
    );
    return patched ? json(patched) : json({ error: 'not found' }, 404);
  });

  app.delete('/todos/:id', async (req) => {
    const id = req.params.id;
    const owner = node.whereis('todos', id);
    if (owner) await node.call(owner, 'crud.removeTodo', { id });
    await ensureIndex(node);
    node.cast('via:indexes/todos', 'todos-index.remove', id);
    return new Response(null, { status: 204 });
  });

  return app;
}
