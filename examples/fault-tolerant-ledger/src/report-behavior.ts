// The report behavior — CPU-bound, and now it OWNS its data access. The API used to read a
// month of rows into memory and ship them here (an OOM waiting to happen on a big month);
// instead the worker streams its OWN cursor and folds incrementally, so nothing buffers on
// either side. The fold is the synchronous work that must not share the API's event loop.
import type { Behavior } from '../../../lib/node/index.ts';
import type { DB } from './db.ts';

type ReportState = { generated: number };
type Summary = { month: string; count: number; totalsByCurrency: Record<string, number> };

// A factory: the worker injects its DB handle, so the behavior holds its own resource — the
// gen_server pattern (state + owned deps), not a pure function fed everything by the caller.
export function makeReportBehavior(db: DB): Behavior<ReportState> {
  return {
    version: '1.0.0',
    init: () => ({ generated: 0 }),
    handlers: {
      // Payload is just { month } now — the worker queries and folds on ITS thread.
      generate: async (state, payload) => {
        const { month } = payload as { month: string };
        const totalsByCurrency: Record<string, number> = {};
        let count = 0;
        for await (const rows of db.monthRows(month)) {
          // The synchronous hot loop — on the worker's thread, never the API's. Flat memory:
          // the cursor yields ~500 rows at a time and we fold them away immediately.
          for (const row of rows) {
            totalsByCurrency[row.currency] =
              (totalsByCurrency[row.currency] ?? 0) + row.amount_cents;
            count += 1;
          }
        }
        const summary: Summary = { month, count, totalsByCurrency };
        return { state: { generated: state.generated + 1 }, reply: summary };
      },
    },
  };
}
