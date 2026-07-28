// The declared failure taxonomy for the ledger — the whole app's `E` vocabulary in one place.
// Every fallible boundary classifies INTO one of these; the HTTP layer maps each to a status.
import { Failure } from '../../../lib/task/index.ts';

export const ValidationFailed = Failure.define(
  'ValidationFailed',
  (d: { field: string; reason: string }) => `invalid ${d.field}: ${d.reason}`,
  { trace: (d) => ({ 'validation.field': d.field }) },
);

export const TransactionNotFound = Failure.define(
  'TransactionNotFound',
  (d: { id: string }) => `no transaction ${d.id}`,
);

// The database is unreachable — a TEMPORARY failure. Readiness flips, k8s pulls the pod from
// the load balancer, callers retry elsewhere. Never a 500 (that would read as a bug).
export const DBUnavailable = Failure.define(
  'DBUnavailable',
  (d: { op: string }) => `database unavailable during ${d.op}`,
);

// The report worker did not answer in time — its node is wedged or gone. Also temporary.
export const ReportUnavailable = Failure.define(
  'ReportUnavailable',
  (d: { month: string }) => `report worker did not answer for ${d.month}`,
);

export type LedgerFailure =
  | Failure.Of<typeof ValidationFailed>
  | Failure.Of<typeof TransactionNotFound>
  | Failure.Of<typeof DBUnavailable>
  | Failure.Of<typeof ReportUnavailable>;

// The ONE place failure kinds meet HTTP — exhaustive, so a new kind can't ship without a status.
export function statusOf(failure: Failure.Any): number {
  switch (failure.code) {
    case 'ValidationFailed':
      return 400;
    case 'TransactionNotFound':
      return 404;
    case 'DBUnavailable':
    case 'ReportUnavailable':
      return 503; // TEMPORARY — retry, don't treat as a bug
    default:
      return 500; // anything undeclared is a bug: loud, opaque to the client
  }
}
