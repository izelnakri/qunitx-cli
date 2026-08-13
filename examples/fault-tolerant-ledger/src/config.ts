// Environment config — the one place that decides which TOPOLOGY this process runs in.
// Everything downstream is topology-agnostic: the same code serves a Worker-thread report
// node (Topology A) or a remote report node over the hub (Topology B). See the README.
export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost/ledger',

  // Report node placement:
  //   unset          → Topology A: spawn a Worker THREAD in this process (CPU isolation, one pod)
  //   ws://hub:4369  → Topology B: the report node is a SEPARATE process/pod, reached via the hub
  reportsHubUrl: process.env.REPORTS_HUB_URL, // e.g. 'ws://ledger-hub:4369'

  reportTimeoutMs: Number(process.env.REPORT_TIMEOUT_MS ?? 30_000),
  heartbeatEveryMs: Number(process.env.HEARTBEAT_EVERY_MS ?? 2_000),
  heartbeatMissAfter: Number(process.env.HEARTBEAT_MISS_AFTER ?? 3),
};

export type Config = typeof config;
