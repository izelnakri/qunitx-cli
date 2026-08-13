// The API node — the process a request hits. Everything here is I/O-BOUND and cooperative, so
// it all shares ONE event loop. The only CPU-bound work — report aggregation — is delegated to
// a POOL of separate report nodes (README §3). Run: node src/api-node.ts
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import * as Node from '../../../lib/node/index.ts';
import * as Supervisor from '../../../lib/supervisor/index.ts';
import { Failure } from '../../../lib/task/index.ts';
import { config } from './config.ts';
import { createDb } from './db.ts';
import { router, replyFor, type Reply } from './http.ts';
import { ValidationFailed, ReportUnavailable } from './failures.ts';

const db = createDb(config);

// ── the report pool ──────────────────────────────────────────────────────────
// Topology A: a POOL of Worker THREADS, each its own report node, bridged into one in-process
// relay so the single API node can talk to all of them and call('group:reports', ...) round-
// robins. A hub is just a frame relay; this is one in-process, across thread boundaries — and
// exactly what makes CPU parallelism possible within one pod. (Topology B: skip all this and
// point REPORTS_HUB_URL at a real hub whose report Deployment IS the group — same call.)
const hub = Node.memoryHub();
const api = Node.start(
  'api@node',
  config.reportsHubUrl ? Node.wsTransport(config.reportsHubUrl) : hub.transport(),
);

function spawnReportWorker(index: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((exited) => {
    const worker = new Worker(new URL('./report-worker.ts', import.meta.url), {
      workerData: { name: `reports@worker-${index}` },
    });
    const bridge = hub.transport(); // this worker's seat in the in-process relay
    bridge.onFrame((frame) => worker.postMessage(frame));
    worker.on('message', (frame) => bridge.send(frame));
    worker.on('error', (e) => console.error(`report worker ${index}:`, e));
    worker.on('exit', () => (bridge.close?.(), exited())); // resolve → the Supervisor restarts it
    signal.addEventListener('abort', () => void worker.terminate());
  });
}

// ── supervision — SUB-POD fault tolerance, no process restart ────────────────
// One supervised child per pool slot. A crashed worker's node leaves 'reports' (nodedown),
// the Supervisor restarts the Worker, and it rejoins — all without k8s touching the pod.
const poolSize = config.reportsHubUrl ? 0 : Math.max(1, availableParallelism() - 1);
const supervisor = Supervisor.start(
  Array.from({ length: poolSize }, (_unused, index) => ({
    id: `report-worker-${index}`,
    restart: 'permanent' as const,
    start: (signal: AbortSignal) => spawnReportWorker(index, signal),
  })),
  { strategy: 'oneForOne', maxRestarts: 10, maxSeconds: 30 },
);

// Readiness for the report path = at least one pool member is enrolled. Group membership IS
// the liveness signal (join on start, nodedown prunes) — no separate heartbeat needed.
const reportsReady = () =>
  config.reportsHubUrl !== undefined || api.groupMembers('reports').length > 0;

// ── routes ───────────────────────────────────────────────────────────────────
const app = router()
  .get('/health', () => ({ status: 200, json: { status: 'ok' } }))

  .get('/ready', async (): Promise<Reply> => {
    const dbOk = await db.ping().result();
    const ready = !Failure.is(dbOk) && reportsReady();
    return { status: ready ? 200 : 503, json: { db: !Failure.is(dbOk), reports: reportsReady() } };
  })

  .post('/transactions', async (ctx): Promise<Reply> => {
    const body = (await ctx.body()) as { amount_cents?: unknown; currency?: unknown };
    if (typeof body.amount_cents !== 'number')
      return replyFor(
        ValidationFailed({ field: 'amount_cents', reason: 'must be a number' }),
        () => ({
          status: 200,
          json: {},
        }),
      );
    const created = await db
      .insert({
        id: crypto.randomUUID(),
        amount_cents: body.amount_cents,
        currency: String(body.currency ?? 'USD'),
      })
      .result();
    return replyFor(created, (tx) => ({ status: 201, json: tx }));
  })

  .get('/transactions/:id', async (ctx): Promise<Reply> => {
    const found = await db.find(ctx.params.id).result();
    return replyFor(found, (tx) => ({ status: 200, json: tx }));
  })

  // Streamed export — I/O-bound, backpressured by the DB cursor. Any file size, flat memory.
  .get('/transactions/export', (ctx): Reply => {
    const after = ctx.query.get('after') ?? '';
    const ndjson = new ReadableStream<Uint8Array>({
      async pull(controller) {
        for await (const rows of db.exportCursor(after)) {
          controller.enqueue(
            new TextEncoder().encode(rows.map((r) => JSON.stringify(r) + '\n').join('')),
          );
        }
        controller.close();
      },
    });
    return { status: 200, stream: ndjson, contentType: 'application/x-ndjson' };
  })

  // THE CPU-BOUND ROUTE. Just delegates: the chosen worker STREAMS the month and folds on its
  // own thread; the API loop only awaits. FAIL-FAST: if no worker is enrolled, return 503 now
  // instead of waiting the full call timeout (the readiness signal, used at request time).
  .post('/reports/monthly', async (ctx): Promise<Reply> => {
    const month = ctx.query.get('month') ?? '';
    if (!/^\d{4}-\d{2}$/.test(month))
      return replyFor(ValidationFailed({ field: 'month', reason: 'expected YYYY-MM' }), () => ({
        status: 200,
        json: {},
      }));
    if (!reportsReady())
      return replyFor(ReportUnavailable({ month }), () => ({ status: 200, json: {} })); // fail fast

    const summary = await api
      .call('group:reports', 'reports.generate', { month }, config.reportTimeoutMs)
      .mapErr((cause) => ReportUnavailable({ month }, { cause })) // CallTimeout / NoGroupMembers → declared
      .result();
    return replyFor(summary, (value) => ({ status: 200, json: value }));
  });

const server = app.listen(config.port, () =>
  console.log(`ledger api on :${config.port} (report pool: ${poolSize})`),
);

// Graceful shutdown — the zero-drop rollout (k8s SIGTERM → drain → SIGKILL).
process.on('SIGTERM', async () => {
  console.log('SIGTERM — draining');
  server.close();
  await supervisor.stop(); // terminates every pool worker in reverse order
  api.stop();
  await db.close();
  process.exit(0);
});
