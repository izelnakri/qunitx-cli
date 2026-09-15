import process from 'node:process';

/**
 * What to say when the page has gone.
 *
 * There is nothing to recover and nothing to offer: a REPL's whole value is the page it is holding
 * — the bindings, the DOM, the module state — and all of it went at once. Reopening one would not
 * bring any of it back; it would be the session you get by running the command again, which the
 * shell already remembers. So the message says what was lost and what to type, and the process
 * ends rather than sitting at a prompt that cannot answer anything.
 *
 * ```ts
 * import { lost } from './session-gone.ts';
 *
 * lost(['node', 'cli.ts', 'repl', 'a.ts']).includes('qunitx repl a.ts'); // true — what to type
 * ```
 */
export function lost(argv: readonly string[] = process.argv): string {
  const again = argv.slice(2).join(' ');

  return [
    'the page is gone — the browser closed, crashed, or was killed.',
    'Everything it was holding went with it, so there is nothing here to carry on with.',
    again === '' ? 'Run qunitx repl again to start over.' : `Start again with: qunitx ${again}`,
  ].join('\n');
}
