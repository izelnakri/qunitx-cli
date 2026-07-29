// A pool of worker-thread NODES — CPU parallelism inside one process, addressed with the same
// call/handle abstraction as the cluster. Lives OUTSIDE the universal barrel (like hub.ts): it
// stands on `node:worker_threads`, which runs on Node and Deno's node-compat. Each worker thread
// runs its own node (via fromPort); the pool's coordinator node reaches all of them over an
// in-process port bus and round-robins a `group`, so a CPU-bound `call` runs off the main loop.
import { Worker, parentPort, workerData } from 'node:worker_threads';
import { start, fromPort } from './node.ts';
import type { Frame, NodeHandle, Transport } from './node.ts';
import type { Task } from '../task/task.ts';
import type { Any as AnyFailure } from '../result/failure.ts';

/**
 * A pool of worker-thread nodes — Elixir's `Task.Supervisor` over a `poolboy` pool. `call`/`cast`
 * round-robin across the threads, so CPU-bound work parallelises without blocking the main loop.
 */
export interface WorkerPool {
  /** Round-robin a `subject` handler across the threads; returns the reply as a Task. */
  call<T = unknown>(subject: string, payload?: unknown, timeoutMs?: number): Task<T, AnyFailure>;
  /** Fire-and-forget to one thread (round-robin). */
  cast(subject: string, payload?: unknown): void;
  /** The `group:<name>` the threads joined — hand it to a cluster node to route work here. */
  group: string;
  /** The coordinator node (bridge the pool into a wider cluster through it). */
  node: NodeHandle;
  /** Resolves once every worker thread has booted and joined the group. */
  ready(): Promise<void>;
  /** Terminate the threads and stop the coordinator. */
  stop(): Promise<void>;
}

/**
 * Spawn `size` worker threads, each running the node behavior in `module` (a file that calls
 * {@link serveWorker}); `call`/`cast` round-robin across them. Work is addressed by subject, not by
 * shipping a closure (JS can't) — the same model as the cluster, one hop closer (a thread, not a
 * machine). Bridge it into a cluster by forwarding an app-node handler to `pool.call`, or, if the
 * coordinator is on the cluster bus, address `pool.group` directly.
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
}): WorkerPool {
  const group = options.group ?? 'workers';
  const id = crypto.randomUUID().slice(0, 8);
  const workers: { name: string; worker: Worker }[] = [];
  let deliver: ((frame: Frame) => void) | undefined;

  for (let i = 0; i < options.size; i += 1) {
    const name = `w${i}-${id}@pool`;
    const worker = new Worker(options.module, {
      workerData: { __pool: { name, group, data: options.workerData } },
    });
    worker.on('message', (frame: Frame) => deliver?.(frame));
    workers.push({ name, worker });
  }

  // A hub-like transport for the coordinator: a targeted frame goes to that worker's port, an
  // untargeted one (hello/bye/join/crdt) fans out to all, inbound frames demux back.
  const bus: Transport = {
    send(frame) {
      if (frame.to) workers.find((w) => w.name === frame.to)?.worker.postMessage(frame);
      else for (const w of workers) w.worker.postMessage(frame);
    },
    onFrame(handler) {
      deliver = handler;
    },
  };
  const coord = start(`coord-${id}@pool`, bus);
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
    async ready() {
      const deadline = Date.now() + 5000;
      while (coord.groupMembers(group).length < options.size && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    },
    async stop() {
      coord.stop();
      await Promise.all(workers.map((w) => w.worker.terminate()));
    },
  };
}

/**
 * The worker-side entry: read the pool's assignment (name + group), start this thread's node, and
 * let `setup` register its handlers. Call it at the top of a {@link workerPool} `module` file.
 *
 * ```ts
 * // cpu-worker.ts, inside a worker thread:
 * // serveWorker((node) => node.handle('fib', (n) => fib(n as number)));
 * typeof serveWorker; // 'function'
 * ```
 */
export function serveWorker(setup: (node: NodeHandle, data: unknown) => void): NodeHandle {
  if (!parentPort) throw new Error('serveWorker() must run inside a worker_threads Worker');
  const assign = (workerData as { __pool?: { name: string; group: string; data: unknown } }).__pool;
  if (!assign) throw new Error('serveWorker() worker was not spawned by workerPool()');
  // parentPort is a node MessagePort — it has on()/postMessage(); cast past its DOM addEventListener
  // overload, which structurally conflicts with fromPort's narrow port shape.
  const node = start(
    assign.name,
    fromPort(parentPort as unknown as Parameters<typeof fromPort>[0]),
  );
  node.join(assign.group);
  setup(node, assign.data);
  return node;
}
