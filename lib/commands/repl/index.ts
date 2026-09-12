import nodeRepl, { type REPLServer } from 'node:repl';
import process from 'node:process';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import * as Args from '../../args/index.ts';
import * as Config from '../../setup/config.ts';
import * as Reporter from '../../reporters/index.ts';
import * as Repl from '../../repl/session.ts';
import * as Result from '../../result/index.ts';
import { blue, red } from '../../utils/color.ts';
import { complete, completionCache, setupSuggestions } from './completion.ts';
import type { CompleterCallback } from './completion.ts';
import { lost, showFrame } from './debugging.ts';
import { define } from './command.ts';
import type { ReplContext } from './command.ts';
import { command as Back } from './commands/back.ts';
import { command as Break } from './commands/break.ts';
import { command as Backtrace } from './commands/backtrace.ts';
import { command as Breakpoints } from './commands/breakpoints.ts';
import { command as Cat } from './commands/cat.ts';
import { command as Clear } from './commands/clear.ts';
import { command as Continue } from './commands/continue.ts';
import { command as Copy } from './commands/copy.ts';
import { command as Doc } from './commands/doc.ts';
import { command as Delete } from './commands/delete.ts';
import { command as Devtools } from './commands/devtools.ts';
import { command as Down } from './commands/down.ts';
import { command as Finish } from './commands/finish.ts';
import { command as Frame } from './commands/frame.ts';
import { command as H } from './commands/h.ts';
import { command as Help } from './commands/help.ts';
import { command as Here } from './commands/here.ts';
import { command as History } from './commands/history.ts';
import { command as Import } from './commands/import.ts';
import { command as Imported } from './commands/imported.ts';
import { command as Tree } from './commands/tree.ts';
import { command as Locals } from './commands/locals.ts';
import { command as Next } from './commands/next.ts';
import { command as Nvim } from './commands/nvim.ts';
import { command as Open } from './commands/open.ts';
import { command as Pwd } from './commands/pwd.ts';
import { command as Reload } from './commands/reload.ts';
import { command as Save } from './commands/save.ts';
import { command as SearchCommand } from './commands/search.ts';
import { command as Scope } from './commands/scope.ts';
import { command as Step } from './commands/step.ts';
import { command as Type } from './commands/type.ts';
import { command as Up } from './commands/up.ts';
import { command as Url } from './commands/url.ts';
import { command as Version } from './commands/version.ts';
import { command as Vi } from './commands/vi.ts';
import { command as Vim } from './commands/vim.ts';
import { command as View } from './commands/view.ts';
import { HISTORY_KEPT, setupHistory } from './history.ts';
import { setupHighlighting } from './painting.ts';
import { setupPreview } from './preview.ts';
import { shell } from './shell.ts';
import { vimKeys } from './keys.ts';
import { findProjectRoot } from '../../utils/find-project-root.ts';
import { ESCAPE } from '../../repl/columns.ts';
import { failure } from './output.ts';
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
  Reporter.info(config, blue(`qunitx repl — ${where(config, session.url)}`));
  // Said on the way in rather than waited for: a browser tab open on the same realm is the thing
  // people reach for next, and nobody guesses that the address exists. Absent where opening it
  // would not work — a window has F12 already, and a session that fell back to a browser
  // Playwright launched has no debugging endpoint to serve DevTools from.
  if (session.inspector !== null) {
    Reporter.info(config, blue(`inspect the same page at ${session.inspector} — or \`.devtools\``));
  }
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
 * Which page is yours, in the words that tell one from the other.
 *
 * A headless Chrome you cannot see and a window that just opened are two different answers to
 * "where is my session", and the banner is the only place anybody is told.
 */
function where(config: ResolvedConfig, url: string): string {
  return config.open === true
    ? `evaluating in the window that just opened (${url})`
    : `evaluating in Chrome at ${url}`;
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
        const input = repl.buffered + source;
        session.eval(input).then(
          (result) => {
            evaluating = false;
            // Whatever just ran may have declared something. Marked stale rather than dropped: the
            // previous answer stays on offer while the new one is on its way, so a suggestion does
            // not blink out after every line.
            completions.stale();
            // Unfinished: keep it, print nothing, and let the prompt say how deep it now is.
            if (result.incomplete) {
              repl.buffered = input.endsWith('\n') ? input : `${input}\n`;

              return callback(null, undefined);
            }
            repl.buffered = '';
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
    //
    // Guarded, because a command that answers after the session has closed would otherwise throw
    // `ERR_USE_AFTER_CLOSE` out of a `then` and take the process with it. A pasted `.exit` on the
    // line after a `.open` is exactly that: both lines arrive together, and the editor is still
    // open when the second one closes the session.
    const prompting = server.displayPrompt.bind(server);
    server.displayPrompt = (preserveCursor?: boolean) => {
      if ((server as unknown as { closed?: boolean }).closed) return;
      if (!interactive) return prompting(preserveCursor);
      const bars = '|'.repeat(Math.max(1, depth(repl.buffered)));
      readline.Interface.prototype.setPrompt.call(
        server,
        repl.buffered === '' ? PROMPT : `${bars} `,
      );
      server.prompt(preserveCursor);
    };

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

    // Everything a command may need that is not its argument, built once. `buffered` and `scratch`
    // live here rather than as closures because the commands that move them are not the only
    // readers — `eval` and the continuation prompt read `buffered` too.
    const repl: ReplContext = {
      server,
      session,
      config,
      cwd,
      palette,
      interactive,
      completions,
      buffered: '',
      scratch: '',
      write: (text) => void server.output.write(text),
      prompt: () => server.displayPrompt(),
    };
    // `node:repl` registers its own `.load` at start-up, and `.help` reads the order names were
    // defined in — left there, it made `.import` an alias of `.load` rather than the other way.
    delete (server.commands as Record<string, unknown>).load;
    // `node:repl`'s `.editor` is dropped: a multi-line paste mode in a REPL that hands you a real
    // editor is the worse of two spellings of the same idea.
    delete (server.commands as Record<string, unknown>).editor;
    define(repl, {
      cat: Cat,
      view: View,
      tree: Tree,
      imported: Imported,
      import: Import,
      doc: Doc,
      type: Type,
      copy: Copy,
      breakpoints: Breakpoints,
      delete: Delete,
      continue: Continue,
      step: Step,
      next: Next,
      finish: Finish,
      backtrace: Backtrace,
      frame: Frame,
      here: Here,
      up: Up,
      back: Back,
      down: Down,
      scope: Scope,
      locals: Locals,
      break: Break,
      clear: Clear,
      reload: Reload,
      open: Open,
      vi: Vi,
      vim: Vim,
      nvim: Nvim,
      save: Save,
      pwd: Pwd,
      version: Version,
      search: SearchCommand,
      help: Help,
      h: H,
      url: Url,
      devtools: Devtools,
      history: History,
    });

    setupHistory(server, interactive);
    // Before the suggestion, and that order matters: both redraw on a keypress, and the ghost has
    // to be written after the line it hangs off has been painted.
    if (interactive) setupHighlighting(server, palette);
    const ghost = interactive ? setupSuggestions(server, completions, cwd) : () => '';
    if (interactive) setupPreview(server, session, () => evaluating, ghost);

    // Registering this listener replaces `node:repl`'s own Ctrl-C handling, so the parts worth
    // keeping are reproduced: interrupt a runaway expression when one is in flight, otherwise
    // abandon the half-typed line. Ctrl-D and `.exit` remain the ways out.
    server.on('SIGINT', () => {
      if (evaluating) return void session.interrupt();
      repl.buffered = '';
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}

// Re-exported so the terminal layer has one door, whichever room a thing lives in.
export { edit, replayableLines, whatToRun } from './editor.ts';
export { complete, setupSuggestions, suggestionStyle } from './completion.ts';
export { lost } from './debugging.ts';
export { recent, trimHistoryFile } from './history.ts';
export { setupHighlighting } from './painting.ts';
export { setupPreview } from './preview.ts';
export { shell } from './shell.ts';
export { vimKeys, withoutTerminalReports } from './keys.ts';
