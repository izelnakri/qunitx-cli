// Side-effect module imported via `node --import` into every test-worker process
// (see test/runner.ts spawnTests). Two responsibilities, both observability-only —
// nothing here changes test behaviour:
//
// 1. Widens util.inspect defaults so node:test's spec-reporter shows full
//    assertion actuals instead of `[Object]` / truncated `'...'`.
//
// 2. Captures the diagnostic surface for the "silent worker death" failure mode
//    where a test worker exits abnormally with no per-test event — node:test
//    then renders the file as a single failed test with body `'test failed'`
//    and no further detail (reproduced locally: a `process.exit(1)` from
//    user code or an import-time crash matches the same shape we saw on
//    CI run 26037993172 / test (windows-latest) for watch-rerun-test.ts).
//    Without this preload that failure mode is undiagnosable from the logs.
//    With it: every process.exit(non-zero), uncaughtException, and
//    unhandledRejection is annotated with `# [worker-preload] ...` + stack
//    so the surrounding context survives to the CI job stream.

import { inspect } from 'node:util';

const o = inspect.defaultOptions;
o.breakLength = 240;
o.depth = Infinity;
o.maxStringLength = Infinity;
o.maxArrayLength = Infinity;

// process.stderr.write is synchronous when wired to a pipe/tty (the case under
// node --test with stdio:'inherit'), so the diagnostic flushes before the
// process terminates. Wrapped in try/catch so a broken stderr (closed, EPIPE)
// can never cascade into a second crash that masks the first one.
function log(label: string, detail: unknown): void {
  try {
    const stack = detail instanceof Error ? detail.stack : String(detail);
    process.stderr.write(`# [worker-preload] ${label}\n${stack}\n`);
  } catch {
    /* swallow */
  }
}

const origExit = process.exit;
// Wrap process.exit so an unexpected non-zero exit carries a stack of WHERE it
// was called from. Zero-exit (clean shutdown) is silent to avoid log noise.
// Cast keeps the signature identical so callers see no behaviour difference.
process.exit = function (code?: number | string | null): never {
  if (code != null && code !== 0)
    log(`process.exit(${code}) called from`, new Error('exit-call traceback'));
  return origExit.call(process, code);
} as typeof process.exit;

// uncaughtException / unhandledRejection: register an observer alongside whatever
// node:test installs internally. Multiple handlers all fire; ours runs purely for
// diagnostic logging and does not suppress the framework's own crash semantics.
process.on('uncaughtException', (err) => log('uncaughtException', err));
process.on('unhandledRejection', (reason) => log('unhandledRejection', reason));
