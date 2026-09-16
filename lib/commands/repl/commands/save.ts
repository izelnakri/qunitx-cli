import path from 'node:path';
import { replayableSource, writeIfPossible } from '../editor.ts';
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
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return saveCommand.main(repl, 'session.js'); // the replayable lines, written there
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Save this session to a file, minus the shell lines',
  main(repl, argument) {
    const target = argument.trim();
    if (target === '') repl.log('Usage: .save <file>');
    else {
      const source = replayableSource(repl.lines);
      const written = writeIfPossible(path.resolve(repl.cwd, target), source);
      repl.log(written ? `Session saved to: ${target}` : red(`Failed to save: ${target}`));
    }
  },
};
