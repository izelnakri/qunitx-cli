import path from 'node:path';
import { replayableLines, tryWriteFile } from '../editor.ts';
import { red } from '../../../utils/color.ts';
import type { ReplCommand } from '../command.ts';

/**
 * `.save` — this session as a file you could run again.
 *
 * Replaces the built-in, which writes every line the session evaluated: that file is meant to be
 * replayable JavaScript, and a shell line is neither JavaScript nor something anyone wants re-run
 * by accident. Filtered here rather than as the line is entered, because `node:repl` records it
 * after `eval` has already answered.
 *
 * ```ts
 * import { command as saveCommand } from './save.ts';
 *
 * saveCommand.description; // what `.help` prints beside it
 * ```
 */
export const command: ReplCommand = {
  description: 'Save this session to a file, minus the shell lines',
  main: (repl, argument) => {
    const target = argument.trim();
    if (target === '') repl.write('Usage: .save <file>\n');
    else {
      const source = replayableLines(repl.server as unknown as { lines?: string[] }).join('\n');
      const written = tryWriteFile(path.resolve(repl.cwd, target), `${source}\n`);
      repl.write(written ? `Session saved to: ${target}\n` : red(`Failed to save: ${target}\n`));
    }
    repl.prompt();
  },
};
