import { paint } from '../../repl/columns.ts';
import type { Theme } from '../../repl/theme.ts';

/** The part of what `node:repl` keeps for a command that this prints — the rest is behaviour. */
interface Described {
  help?: string;
}

const GAP = 2;

/**
 * Every command on one line each, with the names that mean the same thing gathered onto the line
 * they are the same as.
 *
 * A REPL with `.c`, `.s`, `.n`, `.e`, `.bt` and the rest in it has more aliases than commands, and
 * a row apiece turns a screenful into two screenfuls of the same sentences. Grouping is by the help
 * text itself, which is how an alias is written here — the same sentence registered under a second
 * name — so nothing has to declare the relationship twice.
 *
 * The first name registered leads, because that is the spelled-out one; the short ones follow it in
 * the brackets, in the order they were defined.
 *
 * ```ts
 * import { helpLines } from './help.ts';
 *
 * const plain = { style: () => '' };
 * helpLines({ continue: { help: 'Carry on' }, c: { help: 'Carry on' } }, plain);
 * // '.continue  Carry on [aliases .c]'
 * ```
 */
export function helpLines(
  commands: Readonly<Record<string, Described | undefined>>,
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

  const width = Math.max(...rows.map((row) => row.name.length + 1)) + GAP;

  return rows
    .map(({ name, help, aliases }) => {
      const said =
        aliases.length === 0 ? help : `${help} ${paint(alias(aliases), palette.style('LineNr'))}`;

      return `${paint(`.${name}`.padEnd(width), palette.style('@function'))}${said}`;
    })
    .join('\n');
}

/** `[alias .c]` for one, `[aliases .c, .resume]` for more — the spelling `--help` output uses. */
function alias(names: readonly string[]): string {
  const spelled = names.map((name) => `.${name}`).join(', ');

  return `[${names.length === 1 ? 'alias' : 'aliases'} ${spelled}]`;
}
