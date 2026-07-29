// A pool of worker-thread NODES — CPU parallelism inside one process, addressed with the same
// call/handle abstraction as the cluster. Lives OUTSIDE the universal barrel (like hub.ts): it
// stands on `node:worker_threads`, which runs on Node and Deno's node-compat. Each worker thread
// runs its own node; the pool round-robins a `group`, so a CPU-bound `call` runs off the main loop.
// Two modes: LOCAL (default) — a private in-process port bus reaches the threads through the pool's
// coordinator; CLUSTER (`hub`) — the threads join a shared ws hub, so `group:<group>` is visible to
// EVERY node in the cluster. A crashed worker is respawned (a supervised pool).
import { Worker, parentPort, workerData } from 'node:worker_threads';
import { start, fromPort } from './node.ts';
import { wsTransport } from './ws.ts';
import { Task } from '../task/task.ts';
import type { Frame, NodeHandle, Transport } from './node.ts';
import type { Any as AnyFailure } from '../result/failure.ts';

type BusSpec = { kind: 'port' } | { kind: 'ws'; url: string };

/**
 * A pool of worker-thread nodes — Elixir's `Task.Supervisor` over a `poolboy` pool. `call`/`cast`
 * round-robin across the threads, so CPU-bound work parallelises without blocking the main loop.
 */
export interface WorkerPool {
  /** Round-robin a `subject` handler across the threads; returns the reply as a Task. */
  call<T = unknown>(subject: string, payload?: unknown, timeoutMs?: number): Task<T, AnyFailure>;
  /** Fire-and-forget to one thread (round-robin). */
  cast(subject: string, payload?: unknown): void;
  /** The `group:<name>` the threads joined — cluster-wide in `hub` mode. */
  group: string;
  /** The coordinator node (bridge the pool into a wider cluster through it). */
  node: NodeHandle;
  /** Settles once every worker thread has booted and joined the group. */
  ready(): Task<void, AnyFailure>;
  /** Terminate the threads and stop the coordinator. */
  stop(): Task<void, AnyFailure>;
}

/**
 * Spawn `size` worker threads, each running the node behavior in `module` (a file that calls
 * {@link serveWorker}); `call`/`cast` round-robin across them. Work is addressed by subject, not by
 * shipping a closure (JS can't) — the same model as the cluster, one hop closer (a thread, not a
 * machine). A crashed worker is respawned (`respawn`, default true). Pass `hub` (a ws hub URL) to
 * run in CLUSTER mode: the threads join that hub, so `pool.group` is reachable from every node in
 * the cluster; omit it for a private, in-process LOCAL pool.
 *
 * ```ts
 * typeof workerPool; // 'function' — usage needs a real worker module; see serveWorker
 * ```
 */
export function workerPool(options: {
  size: number;
  module: string | URL;
  group?: string;
  workerData?: unknown;
  hub?: string;
  respawn?: boolean;
}): WorkerPool {
  const group = options.group ?? 'workers';
  const id = crypto.randomUUID().slice(0, 8);
  const respawn = options.respawn ?? true;
  const busSpec: BusSpec = options.hub ? { kind: 'ws', url: options.hub } : { kind: 'port' };

  let stopping = false;
  let deliver: ((frame: Frame) => void) | undefined; // LOCAL-mode port-bus inbound sink
  const slots: { name: string; worker: Worker }[] = [];

  const spawn = (i: number, gen: number): void => {
    const name = `w${i}g${gen}-${id}@pool`;
    const worker = new Worker(options.module, {
      workerData: { __pool: { name, group, bus: busSpec, data: options.workerData } },
    });
    if (busSpec.kind === 'port') worker.on('message', (frame: Frame) => deliver?.(frame));
    worker.on('exit', () => {
      if (stopping) return;
      // LOCAL mode: a dead port can't be detected, so synthesize the worker's `bye` — it drops from
      // liveness and the group. (CLUSTER mode: the hub sees the socket close and does this for us.)
      if (busSpec.kind === 'port') deliver?.({ kind: 'bye', from: name });
      if (respawn) spawn(i, gen + 1); // re-arm the slot with a fresh generation
    });
    slots[i] = { name, worker };
  };
  for (let i = 0; i < options.size; i += 1) spawn(i, 0);

  const transport: Transport =
    busSpec.kind === 'ws'
      ? wsTransport(busSpec.url)
      : {
          // A hub-like transport: a targeted frame goes to that worker's port, an untargeted one
          // (hello/bye/join/crdt) fans out to all, inbound frames demux back.
          send(frame) {
            if (frame.to) slots.find((s) => s?.name === frame.to)?.worker.postMessage(frame);
            else for (const s of slots) s?.worker.postMessage(frame);
          },
          onFrame(handler) {
            deliver = handler;
          },
        };
  const coord = start(`coord-${id}@pool`, transport);
  const groupRef = `group:${group}`;

  return {
    group: groupRef,
    node: coord,
    call<T = unknown>(subject: string, payload?: unknown, timeoutMs?: number): Task<T, AnyFailure> {
      return coord.call<T>(groupRef, subject, payload, timeoutMs);
    },
    cast(subject: string, payload?: unknown): void {
      coord.cast(groupRef, subject, payload);
    },
    ready() {
      return Task<void>(async () => {
        const deadline = Date.now() + 8000;
        while (coord.groupMembers(group).length < options.size && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 15));
        }
      }).perform(); // eager — starts on call, like the Promise it replaces; composes with .timeout()
    },
    stop() {
      return Task<void>(async () => {
        stopping = true;
        coord.stop();
        await Promise.all(slots.map((s) => s?.worker.terminate()));
      }).perform();
    },
  };
}

/**
 * The worker-side entry: read the pool's assignment (name + group + bus), start this thread's node,
 * and let `setup` register its handlers. Call it at the top of a {@link workerPool} `module` file.
 *
 * ```ts
 * // cpu-worker.ts, inside a worker thread:
 * // serveWorker((node) => node.handle('fib', (n) => fib(n as number)));
 * typeof serveWorker; // 'function'
 * ```
 */
export function serveWorker(setup: (node: NodeHandle, data: unknown) => void): NodeHandle {
  if (!parentPort) throw new Error('serveWorker() must run inside a worker_threads Worker');
  const assign = (
    workerData as { __pool?: { name: string; group: string; bus: BusSpec; data: unknown } }
  ).__pool;
  if (!assign) throw new Error('serveWorker() worker was not spawned by workerPool()');
  const transport =
    assign.bus.kind === 'ws'
      ? wsTransport(assign.bus.url)
      : // node MessagePort has on()/postMessage(); cast past its DOM addEventListener overload.
        fromPort(parentPort as unknown as Parameters<typeof fromPort>[0]);
  const node = start(assign.name, transport);
  node.join(assign.group);
  setup(node, assign.data);
  return node;
}
