import * as Files from '../../repl/files.ts';
import type { Theme } from '../../repl/theme.ts';
import type { REPLServer } from 'node:repl';
import { red } from '../../utils/color.ts';

/**
 * A directory drawn, with the tally `tree` prints under one — and with whatever the cap left out.
 *
 * Said outright rather than trimmed in silence: a listing that stops without saying so reads as
 * the whole answer, and the way to get the rest is the flag it names.
 */
function showTree(typed: string, cwd: string, palette: Theme, depth: number): string {
  const { listing, counted, omitted } = Files.tree(typed, cwd, palette, depth);
  const tally = `${counted.directories} directories, ${counted.files} files`;
  const cut = omitted === 0 ? '' : ` — ${omitted} more not shown, \`-L\` to narrow`;

  return `${listing}\n\n${tally}${cut}\n`;
}

/** Why a path did not open, in one line. */
function pathProblem(found: Exclude<Files.Resolution, { kind: 'file' }>, target: string): string {
  if (found.kind === 'directory') return `${target} is a directory`;
  if (found.kind === 'missing') {
    return found.retype === ''
      ? `no such file: ${target}`
      : `no such file: ${target} — ${found.retype} exists`;
  }

  return `cannot read ${target}: ${found.detail}`;
}

/**
 * `.cat`, `.view` and `.tree` — what the prompt can show you without leaving it.
 *
 * ```ts
 * import { defineBrowsing } from './browsing.ts';
 *
 * import type { REPLServer } from 'node:repl';
 * import type { Theme } from '../../repl/theme.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(server: REPLServer, palette: Theme) {
 *   defineBrowsing(server, palette, process.cwd(), true, () => Promise.resolve(null));
 * }
 * ```
 */
export function defineBrowsing(
  server: REPLServer,
  palette: Theme,
  cwd: string,
  interactive: boolean,
  asValue: (argument: string) => Promise<string | null>,
): void {
  // `.cat` for the muscle memory, `.view` for anyone without it — but they stopped being the
  // same command once a directory became something worth looking at. `cat` on a directory is an
  // error everywhere, so it stays one here; `.view` shows whatever is there.
  for (const name of ['cat', 'view']) {
    server.defineCommand(name, {
      help:
        name === 'cat'
          ? 'Print a file, numbered and highlighted'
          : 'Show a file numbered, or a directory as a tree (`-L 2` to limit the depth)',
      action(argument: string) {
        this.clearBufferedCommand();
        const { depth, path: typed } = Files.target(argument.trim());
        if (argument.trim() === '') {
          this.output.write(`Usage: .${name} <file>\n`);

          return void this.displayPrompt();
        }

        const found = Files.read(typed, cwd);
        if (found.kind === 'file') {
          this.output.write(`${Files.numbered(found.contents, typed, palette)}\n`);

          return void this.displayPrompt();
        }
        if (found.kind === 'directory' && name === 'view') {
          this.output.write(showTree(typed, cwd, palette, depth));

          return void this.displayPrompt();
        }
        // Everything else leaves the prompt holding the part that WAS real, so the next attempt
        // is a few keystrokes and not the whole path again. TAB and the suggestion take it from
        // there.
        // Not a path it can open — but `.view helper` is a fair thing to type, and a name that
        // is not a file is very likely a value. Only for `.view`: `cat` has never meant that.
        void (name === 'view' ? asValue(typed) : Promise.resolve(null)).then((said) => {
          if (said !== null) {
            this.output.write(`${said}\n`);

            return void this.displayPrompt();
          }
          this.output.write(red(`${pathProblem(found, typed)}\n`));
          this.displayPrompt();
          if (found.kind !== 'unreadable' && interactive) server.write(`.${name} ${found.retype}`);
        });
      },
    });
  }
  // Only ever a tree, so `.tree` on a file says so rather than quietly printing it. Half the
  // value of a narrow command is that it refuses what it is not for. `.ls` because that is what
  // the hand types to see what is in a directory, and `-L 1` is the listing it means by it.
  for (const name of ['tree', 'ls']) {
    server.defineCommand(name, {
      help: 'Show a directory as a tree — `-L 2` for two levels, all the way down by default',
      action(argument: string) {
        this.clearBufferedCommand();
        const { depth, path: typed } = Files.target(argument.trim());
        const found = Files.read(typed, cwd);
        if (found.kind === 'directory') {
          this.output.write(showTree(typed, cwd, palette, depth));
        } else if (found.kind === 'file') {
          this.output.write(red(`${typed} is a file, not a directory\n`));
        } else {
          this.output.write(red(`${pathProblem(found, typed)}\n`));
          this.displayPrompt();

          return void (
            found.kind === 'missing' &&
            interactive &&
            server.write(`.${name} ${found.retype}`)
          );
        }
        this.displayPrompt();
      },
    });
  }
}
