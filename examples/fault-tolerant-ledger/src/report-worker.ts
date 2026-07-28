// The report NODE — runs the CPU-bound behavior on its OWN thread, and now owns its own DB
// handle (it streams the month's cursor itself). It JOINS the 'reports' process group, so the
// API can round-robin a POOL of these with call('group:reports', ...) — real CPU parallelism
// across threads/pods, and group membership doubles as the liveness signal.
//
//   Topology A: spawned as a Worker thread by api-node.ts → talks over its bridged port
//   Topology B: run as its own process → `node report-worker.ts` → talks over the hub
import { parentPort, workerData } from 'node:worker_threads';
import * as Node from '../../../lib/node/index.ts';
import { createDb } from './db.ts';
import { config } from './config.ts';
import { makeReportBehavior } from './report-behavior.ts';

const name = (workerData as { name?: string } | undefined)?.name ?? 'reports@worker';
const transport = parentPort
  ? Node.fromPort(parentPort) // Topology A: a Worker thread
  : Node.wsTransport(config.reportsHubUrl ?? 'ws://localhost:4369'); // Topology B: a pod

const db = createDb(config);
const node = Node.start(name, transport);
Node.serve(node, 'reports', makeReportBehavior(db), { maxMailbox: 64 }); // shed under overload
node.join('reports'); // enrol in the pool — the API routes to 'group:reports'
