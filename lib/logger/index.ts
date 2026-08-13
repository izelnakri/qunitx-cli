// Barrel for the Logger leg: import { logger } from '.../lib/logger/index.ts'.
//
// Elixir's Logger — leveled, structured, JSON logs. Pass it `() => node.trace()` and every line
// auto-carries the ambient distributed-trace id, correlating logs with the request tree and the
// telemetry span for free. Universal, sink-pluggable, with pino-style child loggers.
export { logger, type Logger, type LogLevel, type LogLine } from './logger.ts';
