import * as Repl from '../repl/session.ts';
import * as Options from './options.ts';
import * as Config from '../setup/config.ts';
import { Task } from '../task/index.ts';
import type { ReplSession, ReplStartFailure } from '../repl/session.ts';
import type { UserRunOptions } from './options.ts';
import type { RunFailure } from './test.ts';

/**
 * Every way a REPL can fail to open: the same config failures a run has, plus the two of its own —
 * a browser that cannot be driven over CDP, and a preload file that will not compile.
 *
 * ```ts
 * import { Failure } from '../task/index.ts';
 *
 * // Defined, not invoked: a real failure comes back from `repl(...).result()`.
 * function explain(failure: ReplFailure) {
 *   return `${failure.code}: ${Failure.format(failure)}`; // 'UnsupportedBrowser: …'
 * }
 * ```
 */
export type ReplFailure = RunFailure | ReplStartFailure;

/**
 * Opens a REPL against a live browser page and hands back the session.
 *
 * The verb the CLI's `qunitx repl` is built on, and useful on its own wherever a page needs to be
 * asked questions rather than tested: a scripted browser probe, a documentation example that must
 * really run, a test for something that only exists in a real DOM.
 *
 * `inputs` are preloaded modules, not a test target — each one's exports land on the page's
 * `globalThis`, and any tests it registers run once as the session opens. Nothing else is loaded:
 * unlike `run()`, `package.json#qunitx.inputs` is not a default here.
 *
 * Lazy, like every verb in this API: nothing launches until the {@link Task} is awaited. Nothing
 * is printed either, unless a `reporter` is asked for — tests typed at the prompt are reported
 * through exactly the same reporters a run uses.
 *
 * ```ts
 * import { repl } from './repl.ts';
 *
 * // Defined, not invoked: launches a browser.
 * async function measure() {
 *   await using session = await repl({ inputs: ['test/helpers.ts'] });
 *   const { output } = await session.evaluate('document.querySelector("#qunit-fixture").tagName');
 *   return output; // "'DIV'"
 * }
 * ```
 */
export function repl(options?: UserRunOptions): Task<ReplSession, ReplFailure>;
/**
 * The same session, with the preload named positionally: `repl('test/helpers.ts', { port: 4000 })`.
 *
 * The shape every other verb takes, offered here so they read alike. The positional preload wins
 * over any `inputs` in the options object.
 */
export function repl(
  preload: string | string[],
  options?: UserRunOptions,
): Task<ReplSession, ReplFailure>;
export function repl(
  input: UserRunOptions | string | string[] = {},
  extra?: UserRunOptions,
): Task<ReplSession, ReplFailure> {
  return Task(async () => {
    const configOptions = Options.from(input, extra);
    const config = await Config.setup(configOptions);

    return await Repl.start(config, await Repl.resolvePreload(config, configOptions.inputs ?? []));
  });
}
