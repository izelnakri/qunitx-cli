// The report NODE — the entry point that runs the CPU-bound behavior on its OWN thread.
// Two ways to boot it, one file:
//   Topology A: spawned as a Worker thread by api-node.ts → talks over parentPort (fromPort)
//   Topology B: run as its own process → `node report-worker.ts`, talks over the hub (wsTransport)
import { parentPort } from 'node:worker_threads';
import * as Node from '../../../lib/node/index.ts';
import reportBehavior from './report-behavior.ts';

const transport = parentPort
  ? Node.fromPort(parentPort) // Topology A: a Worker thread, point-to-point with the API
  : Node.wsTransport(process.env.REPORTS_HUB_URL ?? 'ws://localhost:4369'); // Topology B: a pod

const node = Node.start('reports@worker', transport);
Node.serve(node, 'reports', reportBehavior);

// This process/thread is now a report node in the cluster. If it wedges on CPU, ONLY this
// realm freezes — the API stays responsive and its supervised heartbeat notices within
// heartbeatMissAfter ticks. If it OOM-crashes, Topology A's Supervisor restarts the Worker;
// Topology B's k8s restarts the pod. Either way the API never went down.
