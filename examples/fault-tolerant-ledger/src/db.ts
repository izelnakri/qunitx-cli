// The database boundary — the ONLY place raw driver errors exist. Every function here is an
// ADAPTER: it classifies a driver throw INTO the declared taxonomy, so nothing downstream
// ever sees an unclassified error. Uses porsager/postgres (the one external dep).
import postgres from 'postgres';
import { Task } from '../../../lib/task/index.ts';
import { DBUnavailable, TransactionNotFound } from './failures.ts';
import type { Config } from './config.ts';

export type Transaction = {
  id: string;
  amount_cents: number;
  currency: string;
  created_at: string;
};

export type DB = ReturnType<typeof createDb>;

export function createDb(config: Config) {
  const sql = postgres(config.databaseUrl, { max: 10, idle_timeout: 20 });

  return {
    // A cheap liveness probe for readiness — a real round-trip, bounded by Task#await.
    ping: (): Task<true, ReturnType<typeof DBUnavailable>> =>
      Task(async () => {
        await sql`SELECT 1`;
        return true as const;
      }).mapErr((cause) => DBUnavailable({ op: 'ping' }, { cause })),

    insert: (
      tx: Omit<Transaction, 'created_at'>,
    ): Task<Transaction, ReturnType<typeof DBUnavailable>> =>
      Task(async () => {
        const [row] = await sql<Transaction[]>`
          INSERT INTO transactions ${sql(tx)} RETURNING *
        `;
        return row;
      }).mapErr((cause) => DBUnavailable({ op: 'insert' }, { cause })),

    find: (
      id: string,
    ): Task<Transaction, ReturnType<typeof DBUnavailable | typeof TransactionNotFound>> =>
      Task(async () => {
        const [row] = await sql<Transaction[]>`SELECT * FROM transactions WHERE id = ${id}`;
        if (!row) throw TransactionNotFound({ id });
        return row;
      }).mapErr((cause) =>
        // TransactionNotFound is already declared — pass it through; only classify the rest.
        TransactionNotFound.is(cause) ? cause : DBUnavailable({ op: 'find' }, { cause }),
      ),

    // A pull-based cursor: rows flow only as fast as the HTTP response is read — flat memory
    // over millions of rows. `.cursor(n)` is a real server-side portal.
    exportCursor(after: string) {
      return sql<Transaction[]>`
        SELECT * FROM transactions WHERE id > ${after} ORDER BY id
      `.cursor(200);
    },

    // The report worker's raw data source — one month of rows, as an async iterable.
    monthRows(month: string) {
      return sql<Transaction[]>`
        SELECT * FROM transactions
        WHERE to_char(created_at, 'YYYY-MM') = ${month}
        ORDER BY id
      `.cursor(500);
    },

    close: () => sql.end({ timeout: 5 }),
  };
}
