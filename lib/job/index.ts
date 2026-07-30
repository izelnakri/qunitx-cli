// Barrel for the Job leg: import { Job } from '.../lib/job/index.ts'; Job.queue({ ... }).
//
// Elixir's Oban — the durable background-job queue: jobs persist through the Store seam BEFORE
// insert resolves, run under per-queue concurrency limits, retry with backoff to maxAttempts
// (then kept as discarded with their errors), and are rescued after a crash. Telemetry mirrors
// Oban's ['jobs','execute',...] events. Distributed by default: every node drains one shared store,
// the atomic Store.claim (SKIP LOCKED) partitions the work. Cron runs cluster-once via a `leader`
// (Oban's Peer — a store lease).
export {
  Job, // the value namespace (Job.queue/discard/snooze) AND the job record type — same name
  type JobQueue,
  type JobError,
  type JobState,
  type Worker,
  type CronEntry,
} from './job.ts';
export { cronMatch } from './cron.ts';
export { leader, type Leader } from './leader.ts';
export { raftStore } from './raft-store.ts';
