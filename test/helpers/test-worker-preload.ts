// Side-effect module imported via `node --import` into every test-worker process
// (see test/runner.ts spawnTests). Three responsibilities — (1) and (2) are
// observability-only and change no test behaviour; (3) is worker teardown:
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
//
// 3. Stops esbuild's service process once a worker's tests finish, so the worker
//    can exit on its own (see the hook below).

import { after } from 'node:test';
import { inspect } from 'node:util';

const o = inspect.defaultOptions;
o.breakLength = 240;
o.depth = Infinity;
o.maxStringLength = Infinity;
o.maxArrayLength = Infinity;

// esbuild keeps one long-lived `--service` child per process, ref'd along with its two
// stdio sockets, so any worker that touched the esbuild API in-process never exits on its
// own — the real "post-test hang" that --test-force-exit papered over at the cost of
// killing workers mid-report. Lazy import: stop() no-ops if the service never started.
after(async () => {
  const { stop } = await import('esbuild');
  await stop();
});

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

// Final-exit observer. Fires once per process, AFTER all other handlers, for
// any exit path (process.exit, --test-force-exit, end of event loop, signal
// with handler). If we see this with a non-zero code, the worker died and we
// have no other diagnostic, the bare exit-code value at least tells whether
// it was a process.exit(1) (matches our wrap above) vs --test-force-exit (no
// wrap call) vs uncaught (different code) — distinguishing those narrows the
// next investigation. Synchronous-only handler per Node docs.
process.on('exit', (code) => {
  if (code !== 0) log(`process 'exit' event with code ${code}`, new Error('exit observed'));
});

// Signal handlers: SIGTERM / SIGINT can arrive from the parent (e.g. parent
// killing the test worker after a timeout). Without observers, Node's default
// signal handling exits the process with no log. The handler logs and then
// re-raises by removing itself and re-sending the signal — preserves default
// behaviour while adding a breadcrumb.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log(`signal ${sig} received`, new Error('signal observed'));
    process.removeAllListeners(sig);
    process.kill(process.pid, sig);
  });
}

// Startup marker — written once on preload load. Surviving in CI logs means
// the preload itself loaded successfully (rules out an --import failure as
// the cause of a silent death). Goes to stderr so it doesn't interleave with
// the spec-reporter's stdout output.
process.stderr.write(`# [worker-preload] active (pid ${process.pid})\n`);

// Final catch-all: when a test file fails to load (top-level import throws,
// SyntaxError, MODULE_NOT_FOUND, etc.), node:test catches the error and
// emits a generic file-failed event with `'test failed'` and no detail in
// the spec reporter. The throw IS still observable on the unhandledRejection
// path in some Node versions, but the diagnostic landing zone is fragile.
// Patching console.error and process.nextTick to surface anything written
// during the import phase gives us a paper trail when the standard handlers
// stay silent — observed on test (windows-latest) for before-test.ts where
// `'test failed'` printed with zero accompanying diagnostic and no worker
// crash signal.
const originalConsoleError = console.error;
console.error = function (...args: unknown[]): void {
  try {
    process.stderr.write(
      `# [worker-preload] console.error: ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')}\n`,
    );
  } catch {
    /* swallow */
  }
  return originalConsoleError.apply(console, args as []);
};
