import { red } from '../../utils/color.ts';
import type { REPLServer } from 'node:repl';
import type { NameSource } from './completion.ts';
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
 *     repl.write(`${repl.cwd}\n`);
 *     repl.prompt();
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
   * May be `async`: {@link define} floats the promise, so a command that awaits reads top to
   * bottom rather than nesting, and one that rejects is caught there rather than by the process.
   */
  main(repl: ReplContext, argument: string): void | Promise<void>;
}

/**
 * Everything a command may need that is not its argument.
 *
 * One object rather than a parameter list because commands need wildly different subsets of it,
 * and a positional list would make every one of them declare the parts it ignores. `buffered` and
 * `scratch` are mutable ON PURPOSE — they are the session's own state, and the commands that move
 * them (`.break`, `.open`) are the reason it has to outlive a single call.
 */
export interface ReplContext {
  /** The `node:repl` server, for the few commands that need readline itself. */
  server: REPLServer;
  /** The live page, and everything a command can ask it. */
  session: ReplSession;
  /** The resolved run config this session was opened on. */
  config: ResolvedConfig;
  /** The directory relative paths are resolved against. */
  cwd: string;
  /** The colours, already resolved for this terminal — unstyled where there is none. */
  palette: Theme;
  /** False on a pipe — no terminal to hand to an editor, and nothing to redraw. */
  interactive: boolean;
  /** The shared name cache behind TAB and the ghost suggestion. */
  completions: NameSource;
  /** The unfinished input so far, `''` when the line is whole. `.break` abandons it. */
  buffered: string;
  /** The scratch buffer `.open` keeps for the life of the session. */
  scratch: string;
  /** Writes to the prompt's own output. */
  write(text: string): void;
  /** Draws the prompt again — what every command ends with, including the async ones. */
  prompt(): void;
}

/**
 * Registers commands on the server under their own names and every alias.
 *
 * `clearBufferedCommand()` happens here rather than in each `main`: `node:repl` needs it before any
 * command's output, every one of them wanted it, and a command that forgot it printed into a
 * half-drawn line.
 *
 * `node:repl` cannot await an action, so an async command's promise is floated — but caught. A
 * command that rejects has failed, which is a line of output; unhandled, it is Node killing a
 * session over one bad `.doc`.
 *
 * ```ts
 * import { define } from './command.ts';
 *
 * import type { ReplContext } from './command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   define(repl, { pwd: { description: 'Where you are', main: () => repl.prompt() } });
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
              repl.write(red(`.${spelling} failed — ${(error as Error).message}\n`));
              repl.prompt();
            }
          })();
        },
      });
    }
  }
}
