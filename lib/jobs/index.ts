// Barrel for the Jobs leg: import { jobQueue } from '.../lib/jobs/index.ts'.
//
// Elixir's Oban — the durable background-job queue: jobs persist through the Store seam BEFORE
// insert resolves, run under per-queue concurrency limits, retry with backoff to maxAttempts
// (then kept as discarded with their errors), and are rescued after a crash. Telemetry mirrors
// Oban's ['jobs','execute',...] events. Distributed by default: every node drains one shared store,
// the atomic Store.claim (SKIP LOCKED) partitions the work. Cron runs cluster-once via a `leader`
// (Oban's Peer — a store lease).
export {
  jobQueue,
  type JobQueue,
  type Job,
  type JobState,
  type Worker,
  type CronEntry,
} from './jobs.ts';
export { cronMatch } from './cron.ts';
export { leader, type Leader } from './leader.ts';
export { raftStore } from './raft-store.ts';
