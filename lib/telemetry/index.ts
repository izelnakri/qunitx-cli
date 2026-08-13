// Barrel for the Telemetry leg: import * as Telemetry from '.../lib/telemetry/index.ts'.
//
// Elixir's :telemetry — the standard instrumentation bus. Code `execute`s named events with
// measurements + metadata; sinks `attach` handlers; `span` brackets an operation with
// start/stop/exception events carrying a measured duration. Emitter and observer are decoupled,
// so any unit (a Node call, a Supervisor restart, a room actor) can be measured and a
// metrics/tracing backend wired up entirely separately.
export {
  execute,
  attach,
  attachMany,
  detach,
  span,
  listHandlers,
  type EventName,
  type Measurements,
  type Metadata,
  type Handler,
} from './telemetry.ts';
