import path from 'node:path';
import { stat } from 'node:fs/promises';
import * as RunCommand from '../commands/run.ts';
import * as Failure from '../result/failure.ts';
import { Task } from '../task/index.ts';
import type { Console } from '../console.ts';
import type { BrowserLog } from '../reporters/types.ts';
import type { ScriptEntryFailure } from '../commands/run.ts';

// A path only a shell expands. Passing one to `run` means the caller thinks it selects many
// files, which is the test verb's grammar rather than this one's.
const GLOB_CHARACTERS = /[*?[\]{}]/;

/**
 * `run` was handed something that is not one script file.
 *
 * Its own failure rather than a reused `ScriptNotFound` because the two say different things: this
 * one is "you wanted the other verb", and its message says which. `target` is rendered rather than
 * echoed raw so an array or an options object reads as itself.
 *
 * ```ts
 * import { NotAScriptFile } from './run.ts';
 *
 * NotAScriptFile({ target: 'tests/', reason: 'a directory' }).data.reason; // 'a directory'
 * NotAScriptFile({ target: 'tests/', reason: 'a directory' }).message.includes('test('); // true
 * ```
 */
export const NotAScriptFile: Failure.FailureFactory<
  'NotAScriptFile',
  { target: string; reason: string }
> = Failure.define(
  'NotAScriptFile',
  (data: { target: string; reason: string }) =>
    `run() takes one script file, but ${data.target} is ${data.reason}. ` +
    `To run a test suite, call test(${data.target}) instead.`,
);

/**
 * Everything `run` accepts beyond the file itself — the subset of a script run a caller can set.
 *
 * `watch` is deliberately absent. A watching script never finishes, so it cannot be a `Task` that
 * resolves; it needs a session object of its own, the way {@link WatchSession} serves the test
 * verb. Until that exists, asking for it here would return a promise that never settles.
 *
 * ```ts
 * const options: ScriptOptions = { browser: 'firefox', timeout: 30_000 };
 * options.browser; // 'firefox'
 * ```
 */
export interface ScriptOptions {
  /** Directory the file, its relative imports and `node_modules` lookups resolve against. */
  cwd?: string;
  /** Browser engine. Defaults to `chromium`. */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** Port the local server binds. Defaults to 1234, stepping over a taken one. */
  port?: number;
  /** Ms the script may run before it is declared hung. Unbounded by default, like `deno run`. */
  timeout?: number;
  /** Run in a visible browser window instead of headless. */
  open?: boolean;
  /**
   * Where the script's own output goes, exactly as {@link test} and {@link watch} take one.
   * Defaults to this process's stdout and stderr.
   *
   * It is a tee, not a switch: {@link ScriptResult.browserLogs} carries the same lines either way,
   * so `silentConsole` captures the output rather than discarding it.
   */
  console?: Console;
}

/** Every way {@link run} can reject. A script that merely exits non-zero is NOT one of them. */
export type ScriptFailure =
  | Failure.Of<typeof NotAScriptFile>
  | Failure.Of<typeof RunCommand.ScriptBuildFailed>
  | ScriptEntryFailure;

/**
 * What one script run produced.
 *
 * ```ts
 * const result: ScriptResult = {
 *   ok: false,
 *   exitCode: 3,
 *   durationMs: 412,
 *   file: '/proj/scripts/seed.ts',
 *   browserLogs: [{ type: 'log', text: 'seeding…', args: [] }],
 *   browserLogsDropped: 0,
 * };
 * result.ok; // false — the script set a non-zero globalThis.exitCode
 * result.browserLogs[0].text; // 'seeding…' — what it printed, whatever `console` you passed
 * ```
 */
export interface ScriptResult {
  /** True when the script finished with exit code 0. */
  ok: boolean;
  /** `globalThis.exitCode` if the script set one, 1 if it threw, else 0. */
  exitCode: number;
  /** Wall-clock ms from the first bundle to the script's top level settling. */
  durationMs: number;
  /** Absolute path of the file that ran. */
  file: string;
  /**
   * Everything the script printed — its `console` calls and any uncaught error — in emit order,
   * whatever `console` option was passed. The same shape a test run reports, capped the same way.
   */
  browserLogs: BrowserLog[];
  /** How many lines were dropped to stay under the cap. `0` when nothing was. */
  browserLogsDropped: number;
}

/**
 * Runs ONE file as a plain script in a real browser — the API twin of `qunitx run <file>`, and the
 * sibling of {@link test}, which runs a suite.
 *
 * The script is bundled with esbuild and evaluated as a module in the page, so it gets a DOM,
 * `fetch` against a real `http://localhost` origin, `import.meta` and top-level `await`. Its own
 * `console` output goes to this process's stdout and stderr as it happens; the resolved value is
 * the outcome, not the output.
 *
 * **A non-zero exit code is a result, not a rejection** — `ok: false`, the same way a red suite is
 * a result for {@link test}. It rejects only when the script could not be run at all: no such
 * file, a bundle that will not build, or a target that is not a single file.
 *
 * ```ts
 * import { run } from './run.ts';
 *
 * // Defined, not invoked: launches a browser and executes the script.
 * async function seed() {
 *   const result = await run('scripts/seed.ts', { timeout: 30_000 });
 *   return result.ok ? 'seeded' : `exited ${result.exitCode}`;
 * }
 * ```
 */
export function run(file: string, options: ScriptOptions = {}): Task<ScriptResult, ScriptFailure> {
  return Task(async () => {
    const target = refuseNonScript(file);
    const cwd = options.cwd ?? process.cwd();
    // On disk rather than by spelling: `run('tests')` names a directory just as much as
    // `run('tests/')` does, and only a stat can tell the two from a file.
    if (await isDirectory(target, cwd)) {
      throw NotAScriptFile({ target: `'${file}'`, reason: 'a directory' });
    }

    const startedAt = Date.now();
    const outcome = await RunCommand.run(target, {
      cwd: options.cwd,
      browser: options.browser,
      port: options.port,
      portExplicit: options.port !== undefined,
      open: options.open,
      timeout: options.timeout,
      console: options.console,
      // Never watch: the command's watch mode returns a promise that never resolves, so a Task
      // wrapping it could not settle. The watching form needs a session type of its own.
      watch: false,
    });

    return {
      ok: outcome.exitCode === 0,
      exitCode: outcome.exitCode,
      durationMs: Date.now() - startedAt,
      file: outcome.entry,
      browserLogs: outcome.browserLogs,
      browserLogsDropped: outcome.browserLogsDropped,
    };
  });
}

/**
 * Rejects anything that is not one script file, naming `test()` in the message.
 *
 * This exists because of a rename that TypeScript cannot catch. `run('tests/')` used to mean "run
 * that suite" and now means "execute that directory as a script" — same argument, same-looking
 * call, different verb. A silent change of meaning in a published API is worse than an error, so
 * every shape that could only have meant the old verb is refused with the call to make instead.
 *
 * A single file path is the one case this cannot rule on: `run('a-test.ts')` is a legal script
 * run and was a legal suite run. The return type differs, so a typed caller gets a compile error;
 * an untyped one is covered by the release note rather than by this guard.
 */
function refuseNonScript(file: string): string {
  const render = (value: unknown) =>
    typeof value === 'string' ? `'${value}'` : JSON.stringify(value);
  if (Array.isArray(file))
    throw NotAScriptFile({ target: render(file), reason: 'a list of paths' });
  if (typeof file !== 'string') {
    throw NotAScriptFile({ target: render(file), reason: 'not a file path' });
  }
  if (GLOB_CHARACTERS.test(file)) throw NotAScriptFile({ target: render(file), reason: 'a glob' });
  // A trailing separator is a directory by spelling alone, before the filesystem is consulted —
  // and `path.resolve` would strip it, so it has to be caught here.
  if (/[\\/]$/.test(file)) throw NotAScriptFile({ target: render(file), reason: 'a directory' });

  return file;
}

/**
 * True when `file` names a directory. Separate from {@link refuseNonScript} because it is the one
 * check that needs the filesystem; a path that cannot be stat'd is left to the existence check in
 * `configFor`, which reports a missing file far better than this could.
 */
function isDirectory(file: string, cwd: string): Promise<boolean> {
  return stat(path.resolve(cwd, file))
    .then((entry) => entry.isDirectory())
    .catch(() => false);
}
