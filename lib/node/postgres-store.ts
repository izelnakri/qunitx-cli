// A Postgres-backed {@link Store} — the durable, multi-node backend for Job.queue and leader(). It
// imports NO sql package: the developer injects a driver (a ~3-line adapter over `postgres`,
// node-`pg`, or pglite), so this project declares no database dependency and runs no DB in CI.
//
//   const sql = postgres(url);                       // porsager `postgres`
//   const store = postgresStore({ query: (t, p) => sql.unsafe(t, p) });
//
//   const pool = new pg.Pool({ connectionString });  // node-`pg`
//   const store = postgresStore({ query: (t, p) => pool.query(t, p).then((r) => r.rows) });
//
// Leadership uses a `now()`-authority row lease (the DB clock decides expiry, so skewed node clocks
// can't elect two holders) — no advisory lock is needed, since the CP leadership path is
// {@link leader} over a raftStore. Verified behaviorally against real Postgres via the opt-in pglite
// lane (test/pg/*.pg.ts, never in CI); the in-repo tests verify the driver-injection contract.
import type { Store } from './upgradable.ts';

/** The one method a driver must expose — run a parameterized query, return the rows. */
export interface SqlExecutor {
  /** Run a parameterized query (`$1`, `$2`, …) and resolve to the rows. */
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<Row[]>;
}

/**
 * DDL for the two tables {@link postgresStore} uses — run once at deploy (idempotent).
 *
 * ```ts
 * const ddl = postgresStoreSchema();
 * ddl.includes('CREATE TABLE'); // true — feed it to your driver once at deploy
 * ```
 */
export function postgresStoreSchema(options: { table?: string; leases?: string } = {}): string {
  const table = options.table ?? 'qunitx_store';
  const leases = options.leases ?? 'qunitx_leases';
  return (
    `CREATE TABLE IF NOT EXISTS ${table} (key text PRIMARY KEY, state jsonb NOT NULL);\n` +
    `CREATE INDEX IF NOT EXISTS ${table}_jobs ON ${table} ((state->>'queue'), (state->>'state'));\n` +
    `CREATE TABLE IF NOT EXISTS ${leases} ` +
    `(key text PRIMARY KEY, owner text NOT NULL, expires_at timestamptz NOT NULL);`
  );
}

/**
 * Build a {@link Store} over an injected {@link SqlExecutor}. See {@link postgresStoreSchema}.
 *
 * ```ts
 * const store = postgresStore({ query: async () => [] }); // inject your pg/postgres/pglite driver
 * typeof store.save; // 'function'
 * ```
 */
export function postgresStore(
  sql: SqlExecutor,
  options: { table?: string; leases?: string } = {},
): Store {
  const table = options.table ?? 'qunitx_store';
  const leases = options.leases ?? 'qunitx_leases';

  return {
    async load(key) {
      const rows = await sql.query<{ state: unknown }>(
        `SELECT state FROM ${table} WHERE key = $1`,
        [key],
      );
      return rows[0]?.state;
    },

    async save(key, state) {
      await sql.query(
        `INSERT INTO ${table} (key, state) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET state = EXCLUDED.state`,
        [key, JSON.stringify(state)],
      );
    },

    async clear(key) {
      await sql.query(`DELETE FROM ${table} WHERE key = $1`, [key]);
    },

    // SKIP LOCKED: concurrent drainers on separate nodes each grab a disjoint batch; mark them
    // executing with attempt+1 in the same statement, so no job is ever claimed twice.
    async claim(prefix, queue, ready, now, limit) {
      const rows = await sql.query<{ state: Record<string, unknown> }>(
        `WITH due AS (
           SELECT key FROM ${table}
           WHERE key LIKE $1
             AND state->>'queue' = $2
             AND state->>'state' = ANY($3)
             AND (state->>'scheduledAt')::bigint <= $4
           ORDER BY (state->>'priority')::int, (state->>'scheduledAt')::bigint
           LIMIT $5
           FOR UPDATE SKIP LOCKED
         )
         UPDATE ${table} s
         SET state = s.state
             || jsonb_build_object('state', 'executing', 'attemptedAt', $4::bigint)
             || jsonb_build_object('attempt', (s.state->>'attempt')::int + 1)
         FROM due WHERE s.key = due.key
         RETURNING s.state`,
        [`${prefix}:%`, queue, ready, now, limit],
      );
      return rows.map((row) => row.state);
    },

    // The DB's own clock (now()) is the authority — the caller's `now` is intentionally ignored —
    // so across skewed node clocks a TTL lease can never elect two holders. Acquire iff
    // unheld/expired/mine; either way return the current holder.
    async lease(key, candidate, _now, ttlMs) {
      const won = await sql.query<{ owner: string }>(
        `INSERT INTO ${leases} (key, owner, expires_at)
           VALUES ($1, $2, now() + ($3 * interval '1 millisecond'))
         ON CONFLICT (key) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
           WHERE ${leases}.expires_at <= now() OR ${leases}.owner = $2
         RETURNING owner`,
        [key, candidate, ttlMs],
      );
      if (won[0]) return won[0].owner;
      const held = await sql.query<{ owner: string }>(
        `SELECT owner FROM ${leases} WHERE key = $1`,
        [key],
      );
      return held[0]?.owner ?? candidate;
    },

    // Reset jobs stuck executing since before `staleBefore` back to available (or discarded if out
    // of attempts) — the stager/rescuer, one UPDATE. Returns how many were reclaimed.
    async rescue(prefix, staleBefore) {
      const reset = await sql.query<{ key: string }>(
        `UPDATE ${table} SET state = state ||
           CASE WHEN (state->>'attempt')::int >= (state->>'maxAttempts')::int
                THEN jsonb_build_object('state', 'discarded')
                ELSE jsonb_build_object('state', 'available') END
         WHERE key LIKE $1
           AND state->>'state' = 'executing'
           AND (state->>'attemptedAt')::bigint <= $2
         RETURNING key`,
        [`${prefix}:%`, staleBefore],
      );
      return reset.length;
    },
  };
}
