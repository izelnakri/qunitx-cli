// Barrel for the Saga leg: import { saga } from '.../lib/saga/index.ts'.
//
// Elixir's Sage — multi-entity distributed transactions with compensation, above single-key Store
// atomicity. Steps run forward threading a context; on a failure, completed steps' compensations
// run in reverse (the distributed substitute for 2-phase commit). With a Store the step log is
// durable, so a crash-stranded saga rolls back via recover(). Compensations must be idempotent.
export { saga, type SagaHandle, type Step, type SagaResult } from './saga.ts';
