// Barrel for the Jobs leg: import { jobQueue } from '.../lib/jobs/index.ts'.
//
// Elixir's Oban — the durable background-job queue: jobs persist through the Store seam BEFORE
// insert resolves, run under per-queue concurrency limits, retry with backoff to maxAttempts
// (then kept as discarded with their errors), and are rescued after a crash. Telemetry mirrors
// Oban's ['jobs','execute',...] events. Cluster-wide singletons compose from the registry
// (claim a key, only resume while you own it); recurring cron is out of scope by design.
export { jobQueue, type JobQueue, type Job, type JobState, type Worker } from './jobs.ts';
