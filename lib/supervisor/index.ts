// Barrel for the Supervisor leg: import * as Supervisor from '.../lib/supervisor/index.ts'.
// Noun.verb per the repo convention: Supervisor.start(children, options).
//
// Supervision completes the Elixir-shaped system: Result (one settled outcome), Task (one
// future outcome), Stream (many outcomes), Supervisor (KEEPING the outcome producers alive).
// Same failure vocabulary throughout — a child crash is classified into a Failure, reported
// to the observation seam, and answered with a restart until the intensity budget ends the
// tree loudly.
export {
  start,
  dynamic,
  type ChildSpec,
  type Options,
  type SupervisorHandle,
  type DynamicSupervisorHandle,
} from './supervisor.ts';
