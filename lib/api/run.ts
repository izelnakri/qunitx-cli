import { EventEmitter } from 'node:events';
import { setupConfig } from '../setup/config.ts';
import { run as runPipeline } from '../commands/run.ts';
import { RunCompleted } from '../commands/run/tests-in-browser.ts';
import { ApiReporter } from './reporter.ts';
import { toConfigOverrides } from './options.ts';
import { buildResult } from './result.ts';
import { chainableEmitter } from './emitter.ts';
import type { Config } from '../types.ts';
import type { RunEvents, RunOptions, RunResult, RunStartInfo, TestResult } from './types.ts';

/**
 * A running test run. Awaitable for the final {@link RunResult}, and an `EventEmitter` for
 * `runStart` / `testEnd` / `runEnd` while it is in flight — one object rather than two APIs,
 * so streaming is opt-in without changing the call.
 */
export interface RunHandle extends Promise<RunResult> {
  /** Subscribes to an event. Returns the same object, so calls chain. */
  on<Event extends keyof RunEvents>(
    event: Event,
    listener: (...args: RunEvents[Event]) => void,
  ): RunHandle;
  /** Subscribes to the next occurrence of an event only. */
  once<Event extends keyof RunEvents>(
    event: Event,
    listener: (...args: RunEvents[Event]) => void,
  ): RunHandle;
  /** Removes a previously registered listener. */
  off<Event extends keyof RunEvents>(
    event: Event,
    listener: (...args: RunEvents[Event]) => void,
  ): RunHandle;
  /** Aborts the run and tears down the browser and server. Resolves once cleanup is done. */
  stop(): Promise<void>;
}

/**
 * Runs a qunitx suite in a real browser and resolves with its results.
 *
 * The returned handle is a promise, so the common case is a single `await`. It is also an
 * event emitter, so progress can be streamed without a second API:
 *
 * ```ts
 * const result = await run({ files: ['test/**\/*.ts'] });
 * if (!result.ok) console.error(result.failures);
 * ```
 *
 * ```ts
 * const handle = run({ files: ['test/'] });
 * handle.on('testEnd', (test) => bar.tick(test.fullName));
 * const result = await handle;
 * ```
 *
 * Never exits the host process, never sets `process.exitCode`, and never installs signal
 * handlers. The browser, server and esbuild context are torn down before it settles, on both
 * the success and the failure path.
 */
export function run(options: RunOptions = {}): RunHandle {
  const emitter = new EventEmitter();
  // The config is only reachable once setupConfig resolves, but stop() may be called before
  // then; this slot lets the abort path find the live run whenever it becomes available.
  let activeConfig: Config | null = null;
  let stopped = false;

  const stop = async (): Promise<void> => {
    stopped = true;
    // Aborting the browser-side QUnit run is what makes the pipeline unwind through its
    // normal teardown; there is no separate kill path to keep in sync. Awaiting the run
    // itself is what makes stop() resolve only once cleanup has actually finished.
    abortRun(activeConfig);
    await promise.catch(() => {});
  };

  const promise = (async (): Promise<RunResult> => {
    const reporter = new ApiReporter({
      onRunStart: (info: RunStartInfo) => emitter.emit('runStart', info),
      onTestEnd: (test: TestResult) => emitter.emit('testEnd', test),
    });

    const config = await setupConfig({
      cwd: options.cwd,
      // Only `files` goes through argv — that is what gives the API the CLI's exact input
      // semantics (globs, `file.ts#34` line targets). Every other option is passed as a typed
      // override, and the host process's own arguments are never read.
      argv: options.files ?? [],
      overrides: {
        ...toConfigOverrides(options),
        _embedded: true,
        _embeddedServers: new Set(),
      },
    });
    activeConfig = config;
    config._reporters = [...(config._reporters ?? []), reporter];

    if (options.signal) {
      if (options.signal.aborted) stopped = true;
      else options.signal.addEventListener('abort', () => abortRun(config), { once: true });
    }
    // A stop() that landed before setupConfig resolved had no config to abort; apply it now.
    if (stopped) abortRun(config);

    const startedAt = Date.now();
    let exitCode = 0;
    try {
      await runPipeline(config);
      // The pipeline signals completion by throwing RunCompleted in embedded mode; reaching
      // here means it returned early, so fall back on the counter.
      exitCode = config.COUNTER.failCount > 0 ? 1 : 0;
    } catch (error) {
      if (!(error instanceof RunCompleted)) throw error;
      exitCode = error.exitCode;
    }

    const result = buildResult(config, reporter.tests, exitCode, Date.now() - startedAt);
    emitter.emit('runEnd', result);
    return result;
  })();

  // Cast at the boundary: the listener signatures are keyed off the event name, which the
  // untyped EventEmitter underneath cannot express. RunHandle is the checked surface.
  return Object.assign(promise, { ...chainableEmitter(emitter), stop }) as unknown as RunHandle;
}

/**
 * Tells the browser to abort the in-flight QUnit run — the same `abort` broadcast the CLI's
 * `qq` shortcut sends. The pipeline then unwinds through its ordinary completion path, closing
 * the browser and server, so cancellation leaks nothing.
 */
function abortRun(config: Config | null): void {
  config?._embeddedServers?.forEach((server) => server.publish('abort'));
  config?._testRunDone?.();
}
