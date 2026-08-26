import nodeRepl, { type REPLServer } from 'node:repl';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import * as Args from '../../args/index.ts';
import * as Config from '../../setup/config.ts';
import * as Reporter from '../../reporters/index.ts';
import * as Repl from '../../repl/session.ts';
import * as Result from '../../result/index.ts';
import { blue, red } from '../../utils/color.ts';
import { edit, openInEditor, replayableLines, tryWriteFile } from './editor.ts';
import { complete, completionCache, setupSuggestions } from './completion.ts';
import type { CompleterCallback } from './completion.ts';
import { defineDebugging, lost, showFrame } from './debugging.ts';
import { defineBrowsing } from './browsing.ts';
import { helpLines } from './help.ts';
import { defineValues, describeValue, nowhere } from './values.ts';
import * as Search from '../search.ts';
import pkg from '../../../package.json' with { type: 'json' };
import { HISTORY_KEPT, defineHistory, setupHistory } from './history.ts';
import { setupHighlighting } from './painting.ts';
import { setupPreview } from './preview.ts';
import { shell } from './shell.ts';
import { vimKeys } from './keys.ts';
import { findProjectRoot } from '../../utils/find-project-root.ts';
import { ESCAPE, paint } from '../../repl/columns.ts';
import { depth } from '../../repl/highlight.ts';
import { theme } from '../../repl/theme.ts';
import type { ReplSession } from '../../repl/session.ts';
import type { Config as ResolvedConfig } from '../../types.ts';

const PROMPT = '> ';

/**
 * Runs `qunitx repl`: opens a browser page, then reads, evaluates and prints in it until the input
 * ends. Resolves with the process exit code once everything is closed.
 *
 * ```ts
 * import * as ReplCommand from './index.ts';
 *
 * // Defined, not invoked: launches a browser and reads stdin until EOF.
 * async function replCommand() {
 *   return await ReplCommand.run(); // 0 once the session has closed cleanly
 * }
 * ```
 */
export async function run(): Promise<number> {
  const cwd = process.cwd();
  const projectRoot = await findProjectRoot(cwd);
  // argv is parsed here rather than borrowed into `Config.setup`, because the REPL needs an answer
  // the config alone cannot give: which files THIS invocation named. `config.fsTree` folds in
  // `package.json#qunitx.inputs` as well, and a prompt that ran your whole suite before appearing
  // is not what `qunitx repl` means.
  const flags = Result.unwrap(Args.parse(projectRoot, process.argv.slice(3), cwd));
  const config = await Config.setup({ ...flags, cwd });
  // The banner goes in `onOpen` so it lands BEFORE the preloaded files' own tests run — otherwise
  // the first thing on screen is TAP from a session that has not said what it is yet.
  const session = await Repl.start(
    config,
    await Repl.resolvePreload(config, flags.inputs),
    (open) => banner(config, open),
  );

  return await drive(session, config);
}

/** What the session is, what it loaded, and how to leave — through the run's reporters, as `#` lines. */
function banner(config: ResolvedConfig, session: ReplSession): void {
  Reporter.info(config, blue(`qunitx repl — evaluating in Chrome at ${session.url}`));
  for (const [file, names] of session.loaded) {
    const exported = names.length > 0 ? `: ${names.join(', ')}` : '';
    Reporter.info(config, blue(`loaded ${file}${exported}`));
  }
  Reporter.info(
    config,
    blue('type `.help` for commands, `:<cmd>` for a shell, `.exit` or Ctrl-D to quit'),
  );
}

/**
 * Wires the terminal to the page and resolves with the exit code once the input ends.
 *
 * `node:repl` with a custom `eval` rather than a hand-rolled readline loop: history, `.help`,
 * `.exit`, unfinished-input continuation and Ctrl-D all come with it, and Deno's `node:repl` shim
 * supports the same subset, so the compiled binary gets the same prompt. What it does NOT do is
 * wait for an asynchronous `eval` before reading the next line — see {@link pipe}.
 */
function drive(session: ReplSession, config: ResolvedConfig): Promise<number> {
  const cwd = config.cwd;
  return new Promise((resolve) => {
    const interactive = Boolean(process.stdin.isTTY);
    // Piped input goes through a stream this process fills one line at a time. Feeding the REPL
    // `process.stdin` directly delivers the whole pipe in one chunk, and readline then emits every
    // line synchronously — so `echo $'1+1\n2+2' | qunitx repl` started both evaluations at once and
    // reached EOF before either answered. A terminal keeps the real stdin: raw mode, keypresses
    // and history need a TTY, and a human cannot type faster than the page can answer.
    const input = interactive ? vimKeys(process.stdin) : new PassThrough();
    let evaluating = false;
    // Set once the page has gone, so the session ends on the next thing that notices rather than
    // once per command that fails.
    let gone = false;
    // One source of names behind both TAB and the ghost, so the two can never disagree about what
    // the page has.
    const completions = completionCache(session);
    const palette = theme();
    // The unfinished input so far. Held HERE rather than handed to `node:repl` as a `Recoverable`,
    // because the two do different things with it: node's terminal path folds the block into one
    // editable readline line prefixed with a fixed `| ` per row, and hard-codes that prefix's two
    // columns into its cursor arithmetic — so a prompt that says how deep you are cannot be told
    // to it. Buffering here costs the in-place editing of a finished block and buys a prompt that
    // counts, a line that can be painted, and no reliance on `node:repl`'s private symbols.
    let buffered = '';
    const server = nodeRepl.start({
      input,
      output: process.stdout,
      terminal: interactive,
      // No prompt on a pipe, so `echo '1+1' | qunitx repl` prints the answer and nothing else —
      // which is what makes the REPL scriptable, and what its own tests read.
      prompt: interactive ? PROMPT : '',
      // Nothing to print for an input that only registered tests: `ReplResult.output` is empty
      // there, and this is what turns "empty" into no line at all.
      ignoreUndefined: true,
      // `node:repl` keeps thirty lines, which is fewer than `.history` is asked for and fewer than
      // a session gets through before lunch. A shell keeps thousands; so does this. Passed through
      // a cast because `@types/node` does not carry the option, which `node:repl` does honour —
      // it hands it to the readline interface underneath.
      ...({ historySize: HISTORY_KEPT } as object),
      // The session already rendered the value, in the page, with the page's own view of it.
      writer: (value: unknown) => String(value),
      // Replaces `node:repl`'s own, which completes against THIS process's globals — a Node scope
      // with no `document`, no `window` and nothing anybody typed here. Worse, it works out what
      // to list by evaluating the base through `eval`, which for us means running it in the page:
      // pressing TAB after `save()` would have saved.
      completer: (line: string, callback: CompleterCallback) =>
        complete(server, completions, line, callback, cwd),
      eval: (source, _context, _file, callback) => {
        // `:` is the shell, the way `:` is the command line in vim. A prompt you cannot run `git
        // status` from is a prompt you keep leaving, and leaving costs every binding in the page.
        if (source.trimStart().startsWith(':')) {
          evaluating = true;

          return void shell(source.trimStart().slice(1), server.output, cwd).then((code) => {
            evaluating = false;

            return callback(null, code === 0 ? undefined : red(`exit ${code}`));
          });
        }
        evaluating = true;
        const input = buffered + source;
        session.evaluate(input).then(
          (result) => {
            evaluating = false;
            // Whatever just ran may have declared something. Marked stale rather than dropped: the
            // previous answer stays on offer while the new one is on its way, so a suggestion does
            // not blink out after every line.
            completions.stale();
            // Unfinished: keep it, print nothing, and let the prompt say how deep it now is.
            if (result.incomplete) {
              buffered = input.endsWith('\n') ? input : `${input}\n`;

              return callback(null, undefined);
            }
            buffered = '';
            // A pause is not a value and not a failure — it is the page stopping and waiting.
            // Said plainly, with the way out, because a prompt that just returns leaves someone
            // wondering why the next line behaves strangely.
            if (result.pausedAt) {
              server.output.write(
                blue(
                  `paused at ${result.pausedAt} — \`.locals\` for scope, \`.continue\` to carry on\n`,
                ),
              );

              // The lines around it, so which `debugger` this is can be seen rather than worked
              // out from a file and a number. Asked for after the notice, not before: the notice
              // is what the pause IS, and it should not wait on reading a file to say so.
              return void showFrame(server, session, palette).then(() => callback(null, undefined));
            }
            const text = result.failed ? red(failure(result)) : result.output;

            return callback(null, text === '' ? undefined : text);
          },
          (error: Error) => {
            evaluating = false;
            // A failed command means "that did not work"; a page that has gone means "nothing
            // will". Told apart by asking the handles rather than by reading the error, because
            // an ordinary throw from an evaluation must not end the session.
            if (!session.alive()) return void end(server);

            callback(error, undefined);
          },
        );
      },
    });

    /** Says what happened, once, and stops — there is nothing here to carry on with. */
    const end = (target: REPLServer) => {
      if (gone) return;
      gone = true;
      target.output.write(red(`\n${lost()}\n`));
      target.close();
    };

    // One bar per level left open, which is the only thing a continuation prompt has to say.
    // Through readline's own `setPrompt` rather than the REPL's, which would also rewrite the
    // prompt this returns to.
    if (interactive) {
      server.displayPrompt = (preserveCursor?: boolean) => {
        const bars = '|'.repeat(Math.max(1, depth(buffered)));
        readline.Interface.prototype.setPrompt.call(server, buffered === '' ? PROMPT : `${bars} `);
        server.prompt(preserveCursor);
      };
    }
    // `node:repl` calls `clearBufferedCommand()` after every command it finishes, so that is not
    // the hook for abandoning an unfinished one — this is, and it is what `.break` and Ctrl-C have
    // always meant.
    // One name, two jobs, told apart by whether anything follows it. `node:repl` has always used
    // `.break` for abandoning a half-typed block and every debugger has always used it for setting
    // a breakpoint, and both are what somebody typing that FORM means: bare, it is the REPL's;
    // with a place after it, it is the debugger's.
    server.defineCommand('break', {
      help: 'Abandon the unfinished input, or stop the page at a line — `.break lib/a.ts:12`',
      action(argument: string) {
        this.clearBufferedCommand();
        if (argument.trim() === '') {
          buffered = '';

          return void this.displayPrompt();
        }
        void session.addBreakpoint(argument).then((set) => {
          if (typeof set === 'string') this.output.write(red(`${set}\n`));
          else this.output.write(blue(`breakpoint ${set.index} at ${set.where}\n`));
          this.displayPrompt();
        });
      },
    });
    // What every shell means by it, rather than `node:repl`'s "break, and drop the local context"
    // — there is no local context here, and a prompt that has scrolled past what you were reading
    // is the thing anybody actually wants cleared. The half-typed input survives, as it does in a
    // shell: `.clear` is about the screen and nothing else.
    server.defineCommand('clear', {
      help: 'Clear the screen, keeping the scrollback and the unfinished input',
      action() {
        this.clearBufferedCommand();
        // Nothing to clear on a pipe, and the escape would land in whatever is reading it.
        if (interactive) this.output.write(clearScreen());
        this.displayPrompt();
      },
    });

    // A breakpoint reached by a timer, or by anything else this prompt did not start. Without
    // this it stops silently and every line typed afterwards evaluates in a frame nobody
    // mentioned.
    session.whenPaused((where) => {
      // This arrives whenever the page reaches it, which may be halfway through a line somebody
      // is typing. The row is cleared before the notice so it does not land on top of that line,
      // and the prompt is redrawn afterwards WITH its cursor kept — readline still has the line,
      // and `displayPrompt()` on its own would put the caret back at the start of it.
      server.output.write(
        `${ESCAPE}[1G${ESCAPE}[0J${blue(
          `paused at ${where} — \`.locals\` for scope, \`.continue\` to carry on\n`,
        )}`,
      );
      void showFrame(server, session, palette).then(() => server.displayPrompt(true));
    });

    defineDebugging(server, session, palette);
    defineValues(server, session, palette, cwd);
    // `.view` on something that is not a path falls through to the value of that name, with its
    // implementation — the whole of what is known about it, which is what `view` means.
    defineBrowsing(server, palette, cwd, interactive, (argument) =>
      describeValue(session, argument, cwd, palette, { body: true }),
    );
    defineHistory(server, palette);

    setupHistory(server, interactive);
    // Before the suggestion, and that order matters: both redraw on a keypress, and the ghost has
    // to be written after the line it hangs off has been painted.
    if (interactive) setupHighlighting(server, palette);
    const ghost = interactive ? setupSuggestions(server, completions, cwd) : () => '';
    if (interactive) setupPreview(server, session, () => evaluating, ghost);
    server.defineCommand('reload', {
      help: 'Reload the page — drops every binding and all page state',
      action() {
        this.clearBufferedCommand();
        completions.stale();
        session.reload().then(() => this.displayPrompt());
      },
    });
    // One buffer behind all three names, kept for the life of the session. Reopening picks up
    // where the last one left off whichever name you used, because they are one scratchpad and a
    // REPL where the editor forgets is an editor you stop reaching for.
    let scratch = '';
    for (const editor of ['vi', 'vim', 'nvim']) {
      server.defineCommand(editor, {
        help: `Edit a scratch buffer in ${editor}; on exit it runs in the page`,
        action() {
          this.clearBufferedCommand();
          if (!interactive) {
            this.output.write(red(`.${editor} needs a terminal\n`));

            return void this.displayPrompt();
          }

          void edit(editor, scratch, server).then(async (edited) => {
            scratch = edited;
            if (edited.trim() !== '') {
              const result = await session.evaluate(edited);
              const text = result.failed ? red(failure(result)) : result.output;
              if (text !== '') this.output.write(`${text}\n`);
            }
            this.displayPrompt();
          });
        },
      });
    }

    // Replaces the built-in, which writes every line the session evaluated. That file is meant to
    // be replayable JavaScript, and a shell line is neither JavaScript nor something anyone wants
    // re-run by accident. Filtered HERE rather than as the line is entered, because `node:repl`
    // records it after `eval` has already answered.
    server.defineCommand('save', {
      help: 'Save this session to a file, minus the shell lines',
      action(file: string) {
        this.clearBufferedCommand();
        const target = file.trim();
        if (target === '') this.output.write('Usage: .save <file>\n');
        else {
          const source = replayableLines(server as unknown as { lines?: string[] }).join('\n');
          const written = tryWriteFile(path.resolve(cwd, target), `${source}\n`);
          this.output.write(
            written ? `Session saved to: ${target}\n` : red(`Failed to save: ${target}\n`),
          );
        }
        this.displayPrompt();
      },
    });
    // `.open` for what it does to a file, `.edit` for what you are about to do to it, `.e` for
    // the hand that has typed it a thousand times.
    for (const name of ['open', 'edit', 'e']) {
      server.defineCommand(name, {
        help: 'Open the file a value is declared in, at its line',
        action(argument: string) {
          this.clearBufferedCommand();
          void session.declaredAt(argument.trim()).then(async (declared) => {
            // A function knows its own line. Everything else that came into this session came
            // from a file too — the top of it is a better answer than refusing to open anything.
            const from = session.whereFrom(argument);
            const at = declared ?? (from === null ? null : { file: from, line: 1 });
            if (!at) {
              this.output.write(red(`${nowhere(argument, 'open')}\n`));

              return void this.displayPrompt();
            }
            // A pipe has no terminal to hand over, and an editor given one anyway waits for a
            // human who is not there — the session simply stops. Where it cannot open it, the
            // place is still worth saying.
            const failure = interactive
              ? await openInEditor(path.resolve(cwd, at.file), at.line, server)
              : null;
            this.output.write(failure ?? blue(`${at.file}:${at.line}\n`));
            this.displayPrompt();
          });
        },
      });
    }
    server.defineCommand('pwd', {
      help: 'Print the directory paths are resolved against',
      action() {
        this.clearBufferedCommand();
        this.output.write(`${cwd}\n`);
        this.displayPrompt();
      },
    });
    server.defineCommand('version', {
      help: 'Print the qunitx version this session is running',
      action() {
        this.clearBufferedCommand();
        this.output.write(`${pkg.version}\n`);
        this.displayPrompt();
      },
    });
    // The same scan `qunitx search` runs, against the suite this session was opened on — so
    // "which test was that" is a question the prompt can answer without leaving it.
    server.defineCommand('search', {
      help: 'Find tests whose name matches — `.search login`',
      action(argument: string) {
        this.clearBufferedCommand();
        void Search.scan({ ...config, search: argument.trim() || true }).then((found) => {
          this.output.write(
            found.matches.length === 0
              ? `No tests match — ${found.total} in ${found.files} file(s)\n`
              : `${found.matches
                  .map(({ fullName, name, modules, file, line }) => {
                    // `fullName` reads `": a test"` for one declared outside a module, because it
                    // is built to be matched against rather than read.
                    const said = modules.length === 0 ? name : fullName;
                    const where = `${path.relative(cwd, file)}:${line}`;

                    return `${paint(where, palette.style('LineNr'))}  ${said}`;
                  })
                  .join('\n')}\n`,
          );
          this.displayPrompt();
        });
      },
    });
    // `node:repl`'s own help prints a row per name, and this REPL has more names than commands —
    // `.c`, `.s`, `.n`, `.e`, `.bt` and the rest. Gathering the aliases onto the line they are an
    // alias of is the difference between one screenful and two of the same sentences.
    server.defineCommand('help', {
      help: 'Print this list of commands',
      action() {
        this.clearBufferedCommand();
        this.output.write(`${helpLines(server.commands, palette)}\n`);
        this.output.write('Press Ctrl+C to abort the current expression, Ctrl+D to exit\n');
        this.displayPrompt();
      },
    });
    // One key for both questions somebody asks a prompt: what can I type, and what is this.
    server.defineCommand('h', {
      help: 'Help with nothing after it; the documentation for whatever follows it',
      action(argument: string) {
        this.clearBufferedCommand();
        if (argument.trim() === '') {
          server.commands.help?.action?.call(this, '');

          return;
        }
        server.commands.doc?.action?.call(this, argument);
      },
    });
    server.defineCommand('url', {
      help: 'Print the URL this session is served on (open it to watch the page)',
      action() {
        this.clearBufferedCommand();
        this.output.write(`${session.url}\n`);
        this.displayPrompt();
      },
    });

    // Registering this listener replaces `node:repl`'s own Ctrl-C handling, so the parts worth
    // keeping are reproduced: interrupt a runaway expression when one is in flight, otherwise
    // abandon the half-typed line. Ctrl-D and `.exit` remain the ways out.
    server.on('SIGINT', () => {
      if (evaluating) return void session.interrupt();
      buffered = '';
      server.clearBufferedCommand();
      server.output.write('\n');
      server.displayPrompt();
    });

    // Through `settled()`: a paste ends up as several lines read in one go, so a `.exit` on the
    // last of them can reach here while the lines above it are still being answered.
    server.on('exit', () => {
      session
        .settled()
        .then(() => session.close())
        .then(
          () => resolve(gone ? 1 : 0),
          () => resolve(1),
        );
    });

    if (!interactive) void pipe(process.stdin, input as PassThrough, server);
  });
}

/**
 * Feeds `source` into the REPL one line at a time, writing the next only once the REPL has
 * finished with the last.
 *
 * "Finished" is `displayPrompt()`, which the REPL calls after every line it is done with —
 * evaluated, errored, unfinished, or a dot command — and which is therefore the only signal that
 * covers all four. Wrapping it is what makes a piped session behave exactly like a typed one,
 * rather than a burst of overlapping evaluations racing EOF.
 */
async function pipe(
  source: NodeJS.ReadableStream,
  input: PassThrough,
  server: REPLServer,
): Promise<void> {
  // Starts resolved: the REPL displayed its first prompt inside `start()`, before this wrapper
  // existed, so line one is written straight away and every later line waits its turn.
  let ready = deferred();
  ready.resolve();
  // Replaced rather than wrapped, because the original's only other job is choosing WHICH prompt
  // to write — and on a pipe the answer is always none. (Its continuation prompt would otherwise
  // print a stray `| ` in front of a multi-line input's answer.) `prompt()` also resumes a paused
  // input, which is the part that has to keep happening.
  server.displayPrompt = (preserveCursor?: boolean) => {
    server.setPrompt('');
    server.prompt(preserveCursor);
    ready.resolve();
  };

  for await (const line of readline.createInterface({ input: source, crlfDelay: Infinity })) {
    await ready.promise;
    ready = deferred();
    input.write(`${line}\n`);
  }
  // The last line's answer still has to be printed, so EOF waits for it.
  await ready.promise;
  input.end();
}

/** A promise with its resolver, for "wake me when the REPL wants the next line". */
/**
 * A failure, in the words its kind earns.
 *
 * `Uncaught` is what a browser console says about an exception, and belongs only to one the page
 * actually threw. "That file will not bundle" is this REPL answering, and prefixing it would claim
 * the page had refused something it was never shown.
 */
function failure(result: Repl.ReplResult): string {
  return result.thrown ? `Uncaught ${result.output}` : result.output;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}

/**
 * Clears the visible screen and leaves the scrollback alone.
 *
 * `[2J` erases what is on screen; `[3J` would erase what has scrolled off it, which is the
 * difference between clearing a terminal and losing the last hour of it. Only the first is sent,
 * which is why scrolling still works afterwards — and which is what readline already does for
 * Ctrl-L, so that key needs nothing from us.
 */
function clearScreen(): string {
  return `${ESCAPE}[H${ESCAPE}[2J`;
}

// Re-exported so the terminal layer has one door, whichever room a thing lives in.
export { edit, replayableLines } from './editor.ts';
export { complete, setupSuggestions, suggestionStyle } from './completion.ts';
export { lost } from './debugging.ts';
export { recent, trimHistoryFile } from './history.ts';
export { setupHighlighting } from './painting.ts';
export { setupPreview } from './preview.ts';
export { shell } from './shell.ts';
export { vimKeys, withoutTerminalReports } from './keys.ts';
