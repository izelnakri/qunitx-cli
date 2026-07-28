// A durable Store backed by Postgres — the real thing behind room state survival. Lives in the
// example (not lib) because `postgres` is an app dependency; lib defines the Store seam, apps
// bring the backend. Every host in the cluster shares ONE of these (a shared DB), which is what
// lets a room rehydrate on a NEW host after its old one died.
//
// Schema:
//   CREATE TABLE room_state (key text PRIMARY KEY, state jsonb NOT NULL,
//                            updated_at timestamptz NOT NULL DEFAULT now());
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
  };
}
