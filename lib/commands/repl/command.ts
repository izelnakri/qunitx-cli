import { red } from '../../utils/color.ts';
import type * as Repl from '../../repl/session.ts';
import type { NameSource } from './completion.ts';
import type { REPLServer } from 'node:repl';
import type { ReplSession } from '../../repl/session.ts';
import type { Theme } from '../../repl/theme.ts';
import type { Config as ResolvedConfig } from '../../types.ts';

/**
 * One command the prompt answers to: the sentence `.help` prints beside it, and what typing it
 * does.
 *
 * `main` takes a {@link ReplContext} and its argument rather than reading `this`, which is what
 * makes a command a plain function: `tree.main(repl, '-L 1 lib')` runs it, and a test can hand it
 * a context instead of standing up a terminal.
 *
 * ```ts
 * import type { ReplCommand } from './command.ts';
 *
 * const pwd: ReplCommand = {
 *   description: 'Print the directory paths are resolved against',
 *   main(repl) {
 *     repl.log(repl.cwd);
 *   },
 * };
 * pwd.description.length > 0; // true
 * ```
 */
export interface ReplCommand {
  /** What `.help` says about it. One line: the list is read at a glance or not at all. */
  description: string;
  /** Other names for the same command. `.help` folds them onto its line as `[aliases .c, .n]`. */
  aliases?: readonly string[];
  /**
   * What typing it does. `repl` first because nearly every command needs it and many ignore the
   * argument entirely — which they can then simply not declare.
   *
   * `argument` is everything after the name, untrimmed.
   *
   * May be `async`. {@link define} draws the prompt when it finishes and catches what it throws,
   * so a command's job ends when it has said its piece.
   */
  main(repl: ReplContext, argument: string): void | Promise<void>;
}

/**
 * Everything a command may need that is not its argument.
 *
 * Two things here are easy to confuse and worth separating. `repl` is the TERMINAL: the prompt, its
 * colours, the directory it resolves paths against, what it can write. `repl.session` is the PAGE:
 * a live Chrome tab this process drives over CDP, which is where values actually live and where a
 * `debugger` statement actually stops. A command reads the terminal from `repl` and asks the page
 * through `repl.session`; neither reaches into the other.
 *
 * One object rather than a parameter list because commands need wildly different subsets of it,
 * and a positional list would make every one of them declare the parts it ignores. `buffered` and
 * `scratch` are mutable ON PURPOSE — they are the session's own state, and the commands that move
 * them (`.break`, `.open`) are the reason it has to outlive a single call.
 */
export interface ReplContext {
  /** The `node:repl` server, for the few commands that need readline itself. */
  server: REPLServer;
  /** The live page — where values are, and where a `debugger` stops. */
  session: ReplSession;
  /** The resolved run config this session was opened on. */
  config: ResolvedConfig;
  /** The directory relative paths are resolved against. */
  cwd: string;
  /** The colours, already resolved for this terminal — unstyled where there is none. */
  palette: Theme;
  /** False on a pipe — no terminal to hand to an editor, and nothing to redraw. */
  interactive: boolean;
  /** How wide the terminal is, for anything laid out in columns. 80 where nothing says. */
  width: number;
  /**
   * The cached front of {@link ReplSession.completions} — what TAB and the ghost suggestion read.
   *
   * Named for its type rather than for what it feeds, because `repl.completions` beside
   * `repl.session.completions()` put two different things one word apart: this one answers from a
   * cache and never blocks, that one asks the page.
   */
  nameSource: NameSource;
  /** Every line this session has evaluated, oldest first — what `.save` writes out. */
  lines: readonly string[];
  /** The unfinished input so far, `''` when the line is whole. `.break` abandons it. */
  buffered: string;
  /** The scratch buffer `.open` keeps for the life of the session. */
  scratch: string;
  /** Says one line to whoever typed the command, ending it for them. */
  log(text: string): void;
  /** Writes exactly these bytes — for a block that ends in its own newline, or an escape. */
  write(text: string): void;
}

/**
 * The count typed after a command, `fallback` where none was, or `null` where it was not a count.
 *
 * Every command that takes one used to take it and ignore it, which is the worst way to be wrong:
 * `.up 3` moved one frame and said nothing about the other two.
 *
 * ```ts
 * import { asCount } from './command.ts';
 *
 * asCount('3'); // 3
 * asCount(''); // 1 — nothing typed is once
 * asCount('lots'); // null — not a count, and not a silent 1
 * ```
 */
export function asCount(argument: string, fallback: number = 1): number | null {
  const given = argument.trim();
  if (given === '') return fallback;
  const asked = Number(given);

  return Number.isInteger(asked) ? asked : null;
}

/**
 * A failed result, in the words its kind earns.
 *
 * `Uncaught` is what a browser console says about an exception, and belongs only to one the page
 * actually threw. "That file will not bundle" is this REPL answering, and prefixing it would claim
 * the page had refused something it was never shown.
 *
 * ```ts
 * import { failureText } from './command.ts';
 *
 * failureText({ output: 'boom', failed: true, thrown: true, incomplete: false, tests: [] });
 * // 'Uncaught boom'
 * failureText({ output: 'will not bundle', failed: true, incomplete: false, tests: [] });
 * // 'will not bundle' — nothing threw, so nothing is called uncaught
 * ```
 */
export function failureText(result: Repl.ReplResult): string {
  return result.thrown ? `Uncaught ${result.output}` : result.output;
}

/**
 * Registers commands on the server under their own names and every alias.
 *
 * Three things happen here rather than in all thirty-seven commands, because all thirty-seven
 * wanted them and any that forgot one was a bug:
 *
 *   - `clearBufferedCommand()` first. `node:repl` needs it before a command's output, and without
 *     it the output landed in a half-drawn line.
 *   - The prompt afterwards. `node:repl` redraws after a SYNCHRONOUS command and nothing else, so
 *     every async one had to remember to draw its own — which is why they all ended in the same
 *     line, and why forgetting it left a terminal with no prompt.
 *   - A `catch` around the lot. `node:repl` cannot await an action, so the promise is floated —
 *     but caught. A command that rejects has failed, which is a line of output; unhandled, it is
 *     Node killing the session over one bad `.doc`.
 *
 * ```ts
 * import { define } from './command.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   define(repl, { pwd: { description: 'Where you are', main: (it) => it.log(it.cwd) } });
 * }
 * ```
 */
export function define(repl: ReplContext, commands: Record<string, ReplCommand>): void {
  for (const [name, command] of Object.entries(commands)) {
    for (const spelling of [name, ...(command.aliases ?? [])]) {
      repl.server.defineCommand(spelling, {
        help: command.description,
        action(argument: string) {
          this.clearBufferedCommand();
          void (async () => {
            try {
              await command.main(repl, argument);
            } catch (error) {
              repl.log(red(`.${spelling} failed — ${(error as Error).message}`));
            }
            repl.server.displayPrompt();
          })();
        },
      });
    }
  }
}
