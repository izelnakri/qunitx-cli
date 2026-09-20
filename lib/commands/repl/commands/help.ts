import { command as doc } from './doc.ts';
import type { ReplCommand } from '../command.ts';
import type { Theme } from '../../../repl/theme.ts';

/**
 * `.help` — every command with nothing after it, and the documentation for whatever follows it.
 *
 * One question with two shapes, not two commands: "what can I type" and "what is this" are the
 * same reflex, and a prompt that answers only the first sends you looking for the name of the
 * second. `.h` is the same command, because that is what the hand types.
 *
 * The bare form says so on its way out. Somebody who does not know the second shape exists is
 * exactly the person typing `.h`, and the list is the only place they will be looking.
 *
 * The list is grouped rather than one row per name: `node:repl`'s own prints a row per NAME, and
 * this REPL has more names than commands — `.c`, `.s`, `.n`, `.e`, `.bt` and the rest. Folding the
 * aliases onto the line they are an alias of is the difference between one screenful and two of
 * the same sentences.
 *
 * ```ts
 * import { command as helpCommand } from './help.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return helpCommand.main(repl, 'double'); // the docs for it; bare, every command
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Every command with nothing after it; the documentation for whatever follows it',
  aliases: ['h'],
  main(repl, argument) {
    if (argument.trim() !== '') return doc.main(repl, argument);

    repl.log(commandListing(repl.server.commands, repl.palette));
    // The list is what `.help` is reached for, so it is also the only place anybody will find out
    // that it takes an argument. One row of thirty-five saying so is a row nobody reads.
    const dim = repl.palette.painter('LineNr');

    repl.log(dim('Name anything after it for what that is — `.h double`, `.h window.fetch`'));
    repl.log(dim('Ctrl+C aborts the current expression, Ctrl+D exits'));
  },
};

/** What `node:repl` keeps for each registered command. Only the help text is printed here. */
interface RegisteredCommand {
  help?: string;
}

/** Columns between the widest command name and the sentence beside it. */
const NAME_COLUMN_GAP = 2;

/**
 * The listing `.help` prints: every command on a line of its own, aliases folded onto the line
 * they are an alias OF, names in a column.
 *
 * Exported for its own test, not as an API: `.help` is its only caller, and nobody outside this
 * REPL has a `node:repl` command table to hand it.
 *
 * A REPL with `.c`, `.s`, `.n`, `.e`, `.bt` and the rest in it has more aliases than commands, and
 * a row apiece turns a screenful into two screenfuls of the same sentences. Grouping is by the help
 * text itself, which is how an alias is written here — the same sentence registered under a second
 * name — so nothing has to declare the relationship twice.
 *
 * The first name registered leads, because that is the spelled-out one; the short ones follow it in
 * the brackets, in the order they were defined.
 *
 * Data in, string out — the same shape as `frameTable` and `scopeTable`, so a test hands it two
 * literals rather than standing up a terminal.
 *
 * ```ts
 * import { commandListing } from './help.ts';
 *
 * const plain = { painter: () => (text: string) => text };
 * commandListing({ continue: { help: 'Carry on' }, c: { help: 'Carry on' } }, plain);
 * // '.continue  Carry on [aliases .c]'
 * ```
 */
export function commandListing(
  commands: Readonly<Record<string, RegisteredCommand | undefined>>,
  palette: Theme,
): string {
  const groups = new Map<string, string[]>();
  for (const [name, command] of Object.entries(commands)) {
    if (typeof command?.help !== 'string') continue;
    groups.set(command.help, [...(groups.get(command.help) ?? []), name]);
  }

  const rows = [...groups].map(([help, [name, ...aliases]]) => ({
    name: name as string,
    help,
    aliases,
  }));
  rows.sort((one, other) => one.name.localeCompare(other.name));

  const width = Math.max(...rows.map((row) => row.name.length + 1)) + NAME_COLUMN_GAP;

  const dim = palette.painter('LineNr');
  const asCommand = palette.painter('@function');

  return rows
    .map(({ name, help, aliases }) => {
      const said = aliases.length === 0 ? help : `${help} ${dim(aliasNote(aliases))}`;

      return `${asCommand(`.${name}`.padEnd(width))}${said}`;
    })
    .join('\n');
}

/** `[alias .c]` for one, `[aliases .c, .resume]` for more — the spelling `--help` output uses. */
function aliasNote(names: readonly string[]): string {
  const spelled = names.map((name) => `.${name}`).join(', ');

  return `[${names.length === 1 ? 'alias' : 'aliases'} ${spelled}]`;
}
