import { inStyle } from '../../repl/terminal.ts';
import type { Theme } from '../../repl/theme.ts';

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
 * `commandListing` rather than `helpLines`, because it returns one string and not lines — and
 * because three files in this tree were called some form of "help": the CLI's own (`lib/commands/
 * help.ts`), the command (`commands/help.ts`), and this, which is neither.
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
 * import { commandListing } from './command-listing.ts';
 *
 * const plain = { style: () => '' };
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

  return rows
    .map(({ name, help, aliases }) => {
      const said =
        aliases.length === 0
          ? help
          : `${help} ${inStyle(aliasNote(aliases), palette.style('LineNr'))}`;

      return `${inStyle(`.${name}`.padEnd(width), palette.style('@function'))}${said}`;
    })
    .join('\n');
}

/** `[alias .c]` for one, `[aliases .c, .resume]` for more — the spelling `--help` output uses. */
function aliasNote(names: readonly string[]): string {
  const spelled = names.map((name) => `.${name}`).join(', ');

  return `[${names.length === 1 ? 'alias' : 'aliases'} ${spelled}]`;
}
