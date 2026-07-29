// A durable Store backed by Postgres — the real thing behind room state survival AND distributed
// jobs. Lives in the example (not lib) because `postgres` is an app dependency; lib defines the
// Store seam, apps bring the backend. Every host in the cluster shares ONE of these (a shared DB),
// which is what lets a room rehydrate on a NEW host after its old one died — and lets every node
// run the same jobQueue, coordinated by the DB (claim = SKIP LOCKED, lease = a leases row).
//
// Schema:
//   CREATE TABLE room_state (key text PRIMARY KEY, state jsonb NOT NULL,
//                            updated_at timestamptz NOT NULL DEFAULT now());
//   CREATE TABLE job_leases (key text PRIMARY KEY, owner text NOT NULL,
//                            expires_at timestamptz NOT NULL);
//   -- helps the claim's ordered SKIP LOCKED scan under load:
//   CREATE INDEX room_state_jobs ON room_state ((state->>'queue'), (state->>'state'));
//
// Persist-before-ack (serve()'s durability) means each mutating message does one UPSERT here
// before the caller is acked — so a "sent" message is on disk. That is the delta-loss fix: the
// snapshot IS the latest committed state, written synchronously, not a periodic checkpoint.
import postgres from 'postgres';
import type { Store } from '../../../lib/node/index.ts';

export function postgresStore(databaseUrl: string): Store {
  const sql = postgres(databaseUrl);
  return {
    async load(key) {
      const [row] = await sql<
        { state: unknown }[]
      >`SELECT state FROM room_state WHERE key = ${key}`;
      return row?.state;
    },
    async save(key, state) {
      await sql`
        INSERT INTO room_state (key, state) VALUES (${key}, ${sql.json(state as object)})
        ON CONFLICT (key) DO UPDATE SET state = EXCLUDED.state, updated_at = now()
      `;
    },
    async clear(key) {
      await sql`DELETE FROM room_state WHERE key = ${key}`;
    },
    // Oban's fetch, verbatim: select the runnable jobs FOR UPDATE SKIP LOCKED (so concurrent nodes
    // grab disjoint rows), and in the SAME statement mark them executing + bump the attempt. Every
    // node runs this; the DB hands each job to exactly one — no leader, no double execution.
    async claim(prefix, queue, ready, now, limit) {
      const rows = await sql<{ state: unknown }[]>`
        UPDATE room_state
           SET state = state || jsonb_build_object(
                 'state', 'executing',
                 'attempt', ((state->>'attempt')::int + 1),
                 'attemptedAt', ${now})
         WHERE key IN (
           SELECT key FROM room_state
            WHERE key LIKE ${prefix + ':%'}
              AND state->>'queue' = ${queue}
              AND state->>'state' = ANY(${[...ready]})
              AND (state->>'scheduledAt')::bigint <= ${now}
            ORDER BY (state->>'priority')::int, (state->>'scheduledAt')::bigint
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
         )
        RETURNING state
      `;
      return rows.map((r) => r.state);
    },
    // Leadership lease — Oban's Peer. The DB's OWN clock (`now()`) is the authority, so the caller's
    // `now` is intentionally ignored: that is what avoids the cross-node clock-skew split-brain a
    // TTL lease otherwise risks. The conditional upsert acquires only when unheld/expired/mine.
    async lease(key, candidate, _now, ttlMs) {
      const [acquired] = await sql<{ owner: string }[]>`
        INSERT INTO job_leases (key, owner, expires_at)
        VALUES (${key}, ${candidate}, now() + ${ttlMs} * interval '1 millisecond')
        ON CONFLICT (key) DO UPDATE
          SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
          WHERE job_leases.expires_at <= now() OR job_leases.owner = ${candidate}
        RETURNING owner
      `;
      if (acquired) return acquired.owner; // acquired or renewed
      const [current] =
        await sql<{ owner: string }[]>`SELECT owner FROM job_leases WHERE key = ${key}`;
      return current?.owner ?? candidate; // held by someone else (or just vanished — treat as ours)
    },
    // The stager/rescuer (Oban's): jobs stuck `executing` since before `staleBefore` were orphaned
    // by a dead node — reset them to available (or discarded if out of attempts) so a survivor
    // re-runs them. Runs gated behind a leader (once per cluster).
    async rescue(prefix, staleBefore) {
      const rows = await sql<{ key: string }[]>`
        UPDATE room_state
           SET state = state || jsonb_build_object('state',
                 CASE WHEN (state->>'attempt')::int >= (state->>'maxAttempts')::int
                      THEN 'discarded' ELSE 'available' END)
         WHERE key LIKE ${prefix + ':%'}
           AND state->>'state' = 'executing'
           AND (state->>'attemptedAt')::bigint <= ${staleBefore}
        RETURNING key
      `;
      return rows.length;
    },
  };
}
