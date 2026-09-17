import { module, test } from 'qunitx';
import { define, failureText } from '../../lib/commands/repl/command.ts';
import '../helpers/custom-asserts.ts';

import type { ReplCommand, ReplContext } from '../../lib/commands/repl/command.ts';

/** A context that records what was said, and a server that records what was asked of it. */
function fakeRepl() {
  const said: string[] = [];
  const prompts: number[] = [];
  const registered = new Map<string, (argument: string) => void>();
  const server = {
    defineCommand: (name: string, { action }: { action: (argument: string) => void }) =>
      void registered.set(name, action),
    clearBufferedCommand: () => void said.push('<cleared>'),
    displayPrompt: () => void prompts.push(said.length),
  };
  const repl = {
    server,
    log: (text: string) => void said.push(text),
    write: (text: string) => void said.push(text),
  } as unknown as ReplContext;

  /** Types `.name argument` the way `node:repl` would, and waits for it to settle. */
  const type = async (name: string, argument = '') => {
    registered.get(name)?.call(server, argument);
    await new Promise((resolve) => setTimeout(resolve, 5));
  };

  return { repl, said, prompts, registered, type };
}

// Everything here used to be thirty-seven copies of the same three lines, and any command that
// forgot one of them was a bug with no symptom until somebody typed it.
module('Commands | repl | define', { concurrency: true }, () => {
  test('a command is registered under its own name and every alias', (assert) => {
    const { repl, registered } = fakeRepl();

    define(repl, { doc: { description: 'Explain', aliases: ['explain', 'd'], main: () => {} } });

    assert.deepEqual([...registered.keys()], ['doc', 'explain', 'd']);
  });

  test('the prompt is drawn after the command finishes, including an async one', async (assert) => {
    // `node:repl` redraws after a synchronous action and nothing else, so an async command that
    // did not draw its own left the terminal with no prompt.
    const { repl, prompts, type } = fakeRepl();
    define(repl, {
      slow: {
        description: 'Takes a moment',
        main: async (it) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          it.log('done');
        },
      },
    });

    await type('slow');

    // The recorded number is how much had been said when the prompt was drawn: the clear, then
    // the command's own line, then the prompt.
    assert.deepEqual(prompts, [2], 'once, and after the output rather than before it');
  });

  test('a command that throws is a line of output, not a dead session', async (assert) => {
    // Unhandled, a rejected command is Node killing the whole session over one bad `.doc`.
    const { repl, said, prompts, type } = fakeRepl();
    define(repl, {
      boom: { description: 'Fails', main: () => Promise.reject(new Error('the page went')) },
    });

    await type('boom');

    assert.includes(said.join('\n'), '.boom failed — the page went');
    assert.deepEqual(prompts.length, 1, 'and the prompt still comes back');
  });

  test('the buffered command is cleared before anything is printed', async (assert) => {
    // `node:repl` needs it first; without it the output lands in a half-drawn line.
    const { repl, said, type } = fakeRepl();
    define(repl, { pwd: { description: 'Where', main: (it) => it.log('/somewhere') } });

    await type('pwd');

    assert.deepEqual(said, ['<cleared>', '/somewhere']);
  });

  test('the argument reaches main untrimmed, and every alias passes its own', async (assert) => {
    const seen: string[] = [];
    const { repl, type } = fakeRepl();
    const command: ReplCommand = {
      description: 'Records',
      aliases: ['t'],
      main: (_it, argument) => void seen.push(argument),
    };
    define(repl, { tree: command });

    await type('tree', ' -L 2 lib ');
    await type('t', 'x');

    assert.deepEqual(seen, [' -L 2 lib ', 'x']);
  });
});

// The two answers a command argument can be, and the two words a failure earns.
module('Commands | repl | command arguments', { concurrency: true }, () => {
  test('only what the page threw is called uncaught', (assert) => {
    const result = { output: 'boom', failed: true, incomplete: false, tests: [] };

    assert.strictEqual(failureText({ ...result, thrown: true }), 'Uncaught boom');
    assert.strictEqual(failureText(result), 'boom', 'a bundler saying no threw nothing');
  });
});
