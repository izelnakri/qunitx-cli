import { EventEmitter } from 'node:events';
import { setupConfig } from '../setup/config.ts';
import { run as runPipeline } from '../commands/run.ts';
import { ApiReporter } from './reporter.ts';
import { buildResult } from './result.ts';
import { toConfigOverrides } from './options.ts';
import { chainableEmitter } from './emitter.ts';
import type { Config } from '../types.ts';
import type { RunResult, RunStartInfo, TestResult, WatchEvents, WatchOptions } from './types.ts';

/**
 * A live watch session. Emits `change` when a save triggers a rerun, then the usual
 * `runStart` / `testEnd` / `runEnd` for each rerun, until {@link WatchSession.close} is called.
 */
export interface WatchSession {
  /** Subscribes to an event. Returns the same object, so calls chain. */
  on<Event extends keyof WatchEvents>(
    event: Event,
    listener: (...args: WatchEvents[Event]) => void,
  ): WatchSession;
  /** Subscribes to the next occurrence of an event only. */
  once<Event extends keyof WatchEvents>(
    event: Event,
    listener: (...args: WatchEvents[Event]) => void,
  ): WatchSession;
  /** Removes a previously registered listener. */
  off<Event extends keyof WatchEvents>(
    event: Event,
    listener: (...args: WatchEvents[Event]) => void,
  ): WatchSession;
  /** The most recent completed run, or `null` before the first one finishes. */
  readonly lastResult: RunResult | null;
  /** Stops the watchers and closes the browser and server. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Starts a watch session: runs the suite, then reruns it on every relevant file change.
 *
 * Resolves once the first run has completed and the watchers are armed, so a caller that
 * awaits it knows the session is live. Each rerun emits its own event cycle:
 *
 * ```ts
 * const session = await watch({ files: ['test/'] });
 * session.on('runEnd', (result) => notify(`${result.counts.failed} failing`));
 * // ...later
 * await session.close();
 * ```
 *
 * Unlike the CLI's watch mode, no keyboard shortcuts are installed, no SIGTERM handler is
 * registered, and stdin is left alone — the session is driven entirely through this object.
 */
export async function watch(options: WatchOptions = {}): Promise<WatchSession> {
  const emitter = new EventEmitter();
  let lastResult: RunResult | null = null;
  let runStartedAt = Date.now();
  let closed = false;
  const changedFiles = new Set<string>();

  const reporter = new ApiReporter({
    onRunStart: (info: RunStartInfo) => {
      runStartedAt = Date.now();
      emitter.emit('runStart', info);
    },
    onTestEnd: (test: TestResult) => emitter.emit('testEnd', test),
    onRunEnd: () => {
      // Watch reruns never exit, so the code is derived from the counters rather than
      // from a RunCompleted throw as in a one-shot run.
      const exitCode = config.COUNTER.failCount > 0 ? 1 : 0;
      lastResult = buildResult(config, [...reporter.tests], exitCode, Date.now() - runStartedAt);
      emitter.emit('runEnd', lastResult);
    },
  });

  const config: Config = await setupConfig({
    cwd: options.cwd,
    argv: options.files ?? [],
    overrides: {
      ...toConfigOverrides(options),
      watch: true,
      _embedded: true,
      _embeddedServers: new Set(),
      // Batches the changed paths for one rerun: the watcher reports files one at a time, but
      // a consumer wants "these changed, a rerun is starting", not N separate notifications.
      _embeddedOnChange: (file: string) => {
        changedFiles.add(file);
        queueMicrotask(() => {
          if (changedFiles.size === 0) return;
          emitter.emit('change', [...changedFiles]);
          changedFiles.clear();
        });
      },
    },
  });
  config._reporters = [...(config._reporters ?? []), reporter];

  // In watch mode the pipeline returns once the first run is done and the watchers are armed;
  // it does not resolve at "end of testing", so awaiting it is exactly "session is live".
  await runPipeline(config);

  // Cast at the boundary: the listener signatures are keyed off the event name, which the
  // untyped EventEmitter underneath cannot express. WatchSession is the checked surface.
  return {
    ...chainableEmitter(emitter),
    get lastResult() {
      return lastResult;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await config._embeddedTeardown?.();
    },
  } as unknown as WatchSession;
}
