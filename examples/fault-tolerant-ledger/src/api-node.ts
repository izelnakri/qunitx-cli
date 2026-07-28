// The API node — the process a request hits. Everything here is I/O-BOUND and cooperative
// (awaits the DB, awaits the report node), so it all shares ONE event loop happily. The only
// CPU-bound work — report aggregation — is delegated to a SEPARATE report node, which is the
// whole architectural point (README §3). Run: node src/api-node.ts
import { Worker } from 'node:worker_threads';
import * as Node from '../../../lib/node/index.ts';
import * as Supervisor from '../../../lib/supervisor/index.ts';
import { Failure } from '../../../lib/task/index.ts';
import { config } from './config.ts';
import { createDb } from './db.ts';
import { router, replyFor, type Reply } from './http.ts';
import { ValidationFailed, ReportUnavailable } from './failures.ts';

const db = createDb(config);

// ── connect to the report node: Worker thread (A) or remote pod via hub (B) ──
const api = Node.start(
  'api@node',
  config.reportsHubUrl ? Node.wsTransport(config.reportsHubUrl) : reportsWorkerTransport(),
);

function reportsWorkerTransport() {
  // Topology A: the report node is a Worker THREAD in this same process. Separate thread =
  // CPU isolation: a wedged report cannot freeze this API loop. The Supervisor (below)
  // restarts the Worker if it dies.
  const worker = new Worker(new URL('./report-worker.ts', import.meta.url));
  worker.on('error', (e) => console.error('report worker error:', e));
  return Node.fromPort(worker);
}

// ── readiness state, flipped by the supervised heartbeat ─────────────────────
let reportsUp = true;

// ── the supervision tree — SUB-POD fault tolerance, no process restart needed ──
// These are long-running loops; the Supervisor restarts them in place when they crash, so a
// transient fault heals WITHOUT k8s ever restarting the pod. That is the 99.99% story: most
// faults never reach the orchestrator.
const supervisor = Supervisor.start(
  [
    {
      // Watches the report node. On enough missed ticks: flip readiness (k8s pulls us from the
      // load balancer) — but do NOT crash the API; reports being down must not take down /
      // transaction writes, which don't need the report node at all.
      id: 'reports-heartbeat',
      restart: 'permanent', // watch forever; if the watcher itself throws, restart it
      start: Node.heartbeat(api, 'reports@worker', {
        everyMs: config.heartbeatEveryMs,
        missAfter: config.heartbeatMissAfter,
        onDown: () => {
          reportsUp = false;
          console.error('report node DOWN — readiness degraded, transactions still served');
        },
      }),
    },
    {
      // A periodic reaper (stale idempotency keys, expired holds, …). Illustrates a supervised
      // background loop that is safe to restart and must not leak if it throws.
      id: 'reaper',
      restart: 'permanent',
      start: async (signal) => {
        while (!signal.aborted) {
          // await db.sweepExpired();  // real work here
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 60_000);
            signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
          });
        }
      },
    },
  ],
  { strategy: 'oneForOne', maxRestarts: 5, maxSeconds: 30 },
);

// A recovered report node re-answers pings, so re-arm readiness on the next healthy contact.
setInterval(async () => {
  if (!reportsUp && (await api.ping('reports@worker', 1000)) === 'pong') {
    reportsUp = true;
    console.log('report node RECOVERED — readiness restored');
  }
}, config.heartbeatEveryMs).unref();

// ── routes: I/O-bound handlers; the CPU-bound one DELEGATES to the report node ──
const app = router()
  // Liveness: is THIS process alive? Cheap and local. k8s restarts the pod if this fails.
  .get('/health', () => ({ status: 200, json: { status: 'ok' } }))

  // Readiness: can we serve? DB reachable AND (for report routes) the worker up. k8s pulls a
  // not-ready pod from the LB but does NOT restart it — it may recover on its own.
  .get('/ready', async (): Promise<Reply> => {
    const dbOk = await db.ping().result();
    const ready = !Failure.is(dbOk) && reportsUp;
    return { status: ready ? 200 : 503, json: { db: !Failure.is(dbOk), reports: reportsUp } };
  })

  .post('/transactions', async (ctx): Promise<Reply> => {
    const body = (await ctx.body()) as { amount_cents?: unknown; currency?: unknown };
    if (typeof body.amount_cents !== 'number')
      return replyFor(
        ValidationFailed({ field: 'amount_cents', reason: 'must be a number' }),
        () => ({ status: 200, json: {} }),
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

  // THE CPU-BOUND ROUTE. The API reads the rows (I/O) and hands them to the report node, whose
  // handler does the synchronous fold on ITS thread. The API loop stays free the whole time.
  // If the report node is wedged/gone, `call` returns a declared ReportUnavailable → 503.
  .post('/reports/monthly', async (ctx): Promise<Reply> => {
    const month = ctx.query.get('month') ?? '';
    if (!/^\d{4}-\d{2}$/.test(month))
      return replyFor(ValidationFailed({ field: 'month', reason: 'expected YYYY-MM' }), () => ({
        status: 200,
        json: {},
      }));

    const rows: unknown[] = [];
    for await (const chunk of db.monthRows(month)) rows.push(...chunk); // I/O on the API thread

    const summary = await api
      .call('reports@worker', 'reports.generate', { month, rows }, config.reportTimeoutMs)
      .mapErr((cause) => ReportUnavailable({ month }, { cause })) // CallTimeout/node-down → declared
      .result();
    return replyFor(summary, (value) => ({ status: 200, json: value }));
  });

const server = app.listen(config.port, () => console.log(`ledger api on :${config.port}`));

// Graceful shutdown — the zero-drop rollout. k8s sends SIGTERM, waits (terminationGracePeriod),
// then SIGKILL. Stop accepting, drain in-flight requests, tear the tree down in order.
process.on('SIGTERM', async () => {
  console.log('SIGTERM — draining');
  server.close();
  await supervisor.stop();
  api.stop();
  await db.close();
  process.exit(0);
});
