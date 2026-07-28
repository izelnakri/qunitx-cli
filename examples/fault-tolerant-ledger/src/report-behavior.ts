// The report behavior — a `serve()`able unit whose `generate` handler is CPU-BOUND. This is
// the ONE piece of the app that must never share the API's event loop: aggregating a month of
// rows and rendering a summary is synchronous CPU work that would freeze every HTTP request
// on the same thread (see preemption-demo.mjs at the repo root, and the README's §3).
//
// It lives here as a Behavior so it can run EITHER as a Worker thread (Topology A) OR in a
// separate process/pod (Topology B) — same code, placement is a deployment decision.
import type { Behavior } from '../../../lib/node/index.ts';

type Row = { amount_cents: number; currency: string };
type ReportState = { generated: number };
type Summary = { month: string; count: number; totalsByCurrency: Record<string, number> };

const reportBehavior: Behavior<ReportState> = {
  version: '1.0.0',
  init: () => ({ generated: 0 }),
  handlers: {
    // Payload: { month, rows } — the API node reads the cursor (I/O) and ships the ROWS here,
    // so the CPU work (the fold + any rendering) happens on THIS node's thread, not the API's.
    generate: (state, payload) => {
      const { month, rows } = payload as { month: string; rows: Row[] };
      const totalsByCurrency: Record<string, number> = {};
      // The synchronous hot loop — the thing that must not run on the API thread.
      for (const row of rows) {
        totalsByCurrency[row.currency] = (totalsByCurrency[row.currency] ?? 0) + row.amount_cents;
      }
      const summary: Summary = { month, count: rows.length, totalsByCurrency };
      return { state: { generated: state.generated + 1 }, reply: summary };
    },
  },
};

export default reportBehavior;
