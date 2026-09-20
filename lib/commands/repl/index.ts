import nodeRepl, { type REPLServer } from 'node:repl';
import process from 'node:process';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import * as Args from '../../args/index.ts';
import * as Config from '../../setup/config.ts';
import * as Reporter from '../../reporters/index.ts';
import * as Repl from '../../repl/session.ts';
import * as Result from '../../result/index.ts';
import { blue, red } from '../../utils/color.ts';
import { complete, completionCache, setupSuggestionBehaviors } from './completion.ts';
import type { CompleterCallback } from './completion.ts';
import { showFrameSource } from './frames.ts';
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
import { findProjectRoot } from '../../utils/find-project-root.ts';
import { ESCAPE, plain, plainLength, terminalWidth, truncate } from '../../repl/terminal.ts';
import { failureText } from './command.ts';
import { depth, highlight } from '../../repl/highlight.ts';
import { theme } from '../../repl/theme.ts';
import type { Theme } from '../../repl/theme.ts';
import type { ReplSession } from '../../repl/session.ts';
import type { Config as ResolvedConfig } from '../../types.ts';

const PROMPT = '> ';

// Ctrl-K and Ctrl-J as their raw bytes, and the arrows readline already understands.
const CTRL_K = 0x0b;
const CTRL_J = 0x0a;
const ARROW_UP = '\u001b[A';
const ARROW_DOWN = '\u001b[B';
// SGR mouse (`ESC [ < … M|m`), legacy mouse (`ESC [ M` plus three bytes), and cursor position
// (`ESC [ … R`). Built rather than written as literals: a regex literal holding a real escape
// character is exactly what the linter refuses, and it is right to.
const TERMINAL_REPORTS = [
  new RegExp(`${ESCAPE}\\[<\\d+;\\d+;\\d+[Mm]`, 'g'),
  new RegExp(`${ESCAPE}\\[M[\\s\\S]{3}`, 'g'),
  new RegExp(`${ESCAPE}\\[\\d+;\\d+R`, 'g'),
];
// How wide a terminal has to be before an answer can share the line with the question. Under this
// the two fight for the same columns and the answer wins arguments it should not.
const PREVIEW_MINIMUM_COLUMNS = 60;
// And how much room the answer needs to be worth drawing. Less than this is an ellipsis with a
// character in front of it.
const PREVIEW_MINIMUM_WIDTH = 12;
// The gap between what is typed and what it comes to, so the two never read as one expression.
const PREVIEW_GAP = 2;
// Long enough that a burst of typing asks once, short enough to feel like it answered as you went.
const PREVIEW_DELAY_MS = 90;

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
    const input = interactive ? withVimHistoryKeys(process.stdin) : new PassThrough();
    let evaluating = false;
    // Set once the page has gone, so the session ends on the next thing that notices rather than
    // once per command that fails.
    let gone = false;
    // One source of names behind both TAB and the ghost, so the two can never disagree about what
    // the page has.
    const names = completionCache(session);
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
        complete(server, names, line, callback, cwd),
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
            names.stale();
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
              return void showFrameSource(repl).then(() => callback(null, undefined));
            }
            const text = result.failed ? red(failureText(result)) : result.output;

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
      target.output.write(red(`\n${pageGoneMessage()}\n`));
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
      void showFrameSource(repl).then(() => server.displayPrompt(true));
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
      completionCache: names,
      width: terminalWidth(server.output),
      // `node:repl` keeps this and `@types/node` does not admit it, so the cast is here rather
      // than at the one command that reads it.
      get lines() {
        return (server as unknown as { lines?: string[] }).lines ?? [];
      },
      buffered: '',
      scratch: '',
      log: (text) => void server.output.write(`${text}\n`),
      write: (text) => void server.output.write(text),
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
      url: Url,
      devtools: Devtools,
      history: History,
    });

    setupHistory(server, interactive);
    // Before the suggestion, and that order matters: both redraw on a keypress, and the ghost has
    // to be written after the line it hangs off has been painted.
    if (interactive) setupLineHighlighting(server, palette);
    const ghost = interactive ? setupSuggestionBehaviors(server, names, cwd) : () => '';
    if (interactive) {
      setupRightMarginPreview(server, session, {
        isEvaluating: () => evaluating,
        suggestionOnTheRow: ghost,
      });
    }

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
export { edit, meansYes, replayableSource, whatToRun } from './editor.ts';
export { complete, setupSuggestionBehaviors, mutedSuggestionStyle } from './completion.ts';
export { trimHistoryFile } from './history.ts';

// ── The prompt itself ─────────────────────────────────────────────────────────
//
// Five things that only `drive` above calls, and that only exist so it stays readable: the input
// stream it reads, the colours it types in, the answer it shows before Enter, the shell `:` runs
// a command through, and what it says when the page goes. Each was its own file until a reviewer
// pointed out that a module nobody imports twice is a file you open once and never again.

/**
 * `stdin`, with Ctrl-K and Ctrl-J walking history — a NEW stream, which is what to read instead.
 *
 * Rewritten bytes rather than a keypress listener, for two reasons a listener cannot get around.
 * Ctrl-K already means kill-to-end-of-line, and a second listener does not replace readline's — it
 * runs as well, so the line would be shredded on the way to the previous entry. And Ctrl-J is not
 * a distinguishable key at all: it arrives as `\n`, which readline reads as Enter and every
 * multi-line paste is full of. Binding it by name would stop pastes submitting.
 *
 * The paste is what the single-byte test is for. A keystroke arrives on its own; a paste arrives
 * as a chunk, so a `\n` with company is left exactly as it was and still submits its line.
 *
 * What comes back stands in for the TTY it wraps — readline needs `isTTY` and `setRawMode` to put
 * the terminal in the mode this depends on, and neither belongs to a plain PassThrough.
 *
 * ```ts
 * import { PassThrough } from 'node:stream';
 * import { withVimHistoryKeys } from './index.ts';
 *
 * const stdin = Object.assign(new PassThrough(), { setRawMode: () => {} });
 * withVimHistoryKeys(stdin as unknown as NodeJS.ReadStream).isTTY; // true — readline must believe it
 * ```
 */
export function withVimHistoryKeys(stdin: NodeJS.ReadStream): NodeJS.ReadStream {
  const translated = new PassThrough();

  stdin.on('data', (chunk: Buffer) => {
    if (chunk.length === 1 && chunk[0] === CTRL_K) return void translated.write(ARROW_UP);
    if (chunk.length === 1 && chunk[0] === CTRL_J) return void translated.write(ARROW_DOWN);
    translated.write(withoutTerminalReports(chunk));
  });
  stdin.on('end', () => translated.end());

  return Object.defineProperties(translated as unknown as NodeJS.ReadStream, {
    isTTY: { value: true },
    setRawMode: { value: (mode: boolean) => stdin.setRawMode(mode) },
  });
}

/**
 * The same bytes with the terminal's answers to ITSELF dropped: mouse and cursor-position reports.
 *
 * These are input in the sense that they arrive on stdin, and never in the sense that anyone typed
 * them. An editor turns mouse tracking on; the terminal then reports every click and drag as
 * `ESC [ < 32 ; 14 ; 45 M`, and the ones that arrive while nobody is reading sit in the TTY buffer
 * until somebody is. That somebody was the prompt, which rendered them as text and then failed to
 * parse them — the `32;14;45M32;11;45M…` after quitting nvim, and the `Invalid or unexpected
 * token` on the line after.
 *
 * Filtered by SHAPE rather than by timing: a report is recognisable, and dropping it is right
 * whenever it turns up. A settle window would only be a guess about how long the mess lasts.
 *
 * ```ts
 * import { withoutTerminalReports } from './index.ts';
 *
 * const ESC = String.fromCharCode(27);
 * withoutTerminalReports(Buffer.from(`a${ESC}[<32;14;45Mb`)).toString(); // 'ab'
 * withoutTerminalReports(Buffer.from('1 + 1')).toString(); // '1 + 1' — typing is untouched
 * ```
 */
export function withoutTerminalReports(chunk: Buffer): Buffer {
  const text = chunk.toString('binary');
  if (!text.includes(ESCAPE)) return chunk;

  const stripped = TERMINAL_REPORTS.reduce((rest, report) => rest.replace(report, ''), text);

  return stripped === text ? chunk : Buffer.from(stripped, 'binary');
}

/**
 * Paints the line AS IT IS TYPED, in the colours the theme gives each capture.
 *
 * Two halves. `_writeToOutput` is where readline puts the prompt and the line on screen, so that
 * is where the line is swapped for a painted one — the substitution is by VALUE, and anything
 * that is not exactly what readline believes the line to be passes through untouched. And a
 * refresh is asked for on every keypress, because readline appends a typed character in place
 * rather than redrawing, and a keyword cannot be recognised one character at a time.
 *
 * Only what is written changes, never what readline computed: the painted line occupies the same
 * columns as the plain one, so every cursor position readline worked out still lands where it
 * meant to.
 *
 * ```ts
 * import { setupLineHighlighting } from './index.ts';
 * import { theme } from '../../repl/theme.ts';
 *
 * import type { REPLServer } from 'node:repl';
 *
 * // Defined, not invoked: it draws on a live terminal.
 * function example(server: REPLServer) {
 *   setupLineHighlighting(server, theme());
 * }
 * ```
 */
export function setupLineHighlighting(server: REPLServer, palette: Theme): void {
  const internals = server as unknown as {
    _writeToOutput(text: string): void;
    _refreshLine(): void;
  };
  const write = internals._writeToOutput.bind(server);

  internals._writeToOutput = (text: string) => {
    const line = server.line ?? '';
    const prompt = server.getPrompt();
    // Exactly the prompt and the line, which is what a refresh writes and what nothing else does.
    // A single appended character, a trailing space, a continuation row: none of them match, and
    // all of them are written as readline wrote them.
    const painting = line !== '' && text === `${prompt}${line}`;

    return write(painting ? `${prompt}${highlight(line, palette)}` : text);
  };

  let scheduled = false;
  server.input.on('keypress', () => {
    // After readline has finished with this same keypress — refreshing under it would be undone.
    // At most once a tick: a paste arrives as one chunk and readline reads a keypress per
    // character, so without this a hundred-character paste repaints the line a hundred times.
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      // Nothing to paint on an empty line, and a redraw of one is actively wrong: the keypress
      // that empties the line is Enter, which submits it, and the prompt this would draw belongs
      // to the input just SENT rather than to the next one. It landed in front of the answer —
      // `| undefined` for a block that had finished. Deleting back to empty is readline's own
      // redraw, so nothing is lost by leaving that to it.
      if ((server.line ?? '') !== '') internals._refreshLine();
    });
  });
}

/** What else is on the row, and whether the page is busy — the two things a preview must not fight. */
interface PreviewRoom {
  /** Is an evaluation already in flight? One is enough for the page to be doing. */
  isEvaluating(): boolean;
  /** The ghost suggestion drawn after the cursor, whose columns are already taken. */
  suggestionOnTheRow(): string;
}

/**
 * Shows what the line would come to, dimmed against the RIGHT MARGIN while it is still being typed.
 *
 * ```
 * > document.title                                              'qunitx repl'
 * ```
 *
 * Free by construction: the session evaluates with V8 refusing anything that has a side effect, so
 * an expression that would change something answers nothing at all rather than changing it. What
 * is left is worth showing before Enter, which is the whole point — the answer to `1 + 1` is not
 * worth a round of the read-eval-print loop.
 *
 * Drawn only where there is room for it, and on ONE line. A narrow terminal, a line already near
 * the edge, a value that needs more columns than are left: in each case it is cut to the room or
 * not drawn at all, because a preview that crowds the line it belongs to costs more than it gives.
 * Painted in the colours the page rendered it in, which are the colours the same value will be
 * printed in a keystroke later.
 *
 * ```ts
 * import { setupRightMarginPreview } from './index.ts';
 *
 * import type { REPLServer } from 'node:repl';
 * import type { ReplSession } from '../../repl/session.ts';
 *
 * // Defined, not invoked: it evaluates in a live page and draws on a live terminal.
 * function example(server: REPLServer, session: ReplSession) {
 *   setupRightMarginPreview(server, session, {
 *     isEvaluating: () => false,
 *     suggestionOnTheRow: () => '',
 *   });
 * }
 * ```
 */
export function setupRightMarginPreview(
  server: REPLServer,
  session: ReplSession,
  { isEvaluating, suggestionOnTheRow }: PreviewRoom,
): void {
  let timer: NodeJS.Timeout | undefined;

  const room = (line: string): number => {
    const columns = (server.output as NodeJS.WriteStream).columns ?? 0;
    // The suggestion counts: it is drawn after the cursor on this same row, and a preview that
    // ignores it lands on top of the tail of what it is offering.
    const used = plainLength(server.getPrompt()) + line.length + plainLength(suggestionOnTheRow());
    // A line that has already wrapped has no right margin left to draw against, and working out
    // where its rows are is arithmetic readline has already done for itself.
    if (columns < PREVIEW_MINIMUM_COLUMNS || used >= columns) return 0;

    return columns - used - PREVIEW_GAP;
  };

  const ask = () => {
    const line = server.line ?? '';
    // A dot command is not an expression, `:` is the shell, and an unfinished line is not worth
    // asking about — the answer to half a line is a syntax error nobody typed yet.
    const askable =
      line.trim() !== '' &&
      !line.trimStart().startsWith('.') &&
      !line.trimStart().startsWith(':') &&
      !isEvaluating() &&
      room(line) >= PREVIEW_MINIMUM_WIDTH;
    if (!askable) return;

    void session.preview(line).then((rendered) => {
      // ONE line, whatever it took to render. `window.self` comes back as a page of an object
      // graph, and a value that shares a row with what is being typed cannot bring its own rows
      // with it — the newlines land in the middle of the prompt and take the layout apart.
      const value = rendered.replace(/\s*\n\s*/g, ' ');
      // Decisions are made on the text, drawing on the colours: a value rendered as `undefined`
      // is dim, and dim is escape codes that would never compare equal to anything.
      const text = plain(value);
      // The line may have moved on while the page was answering, and an answer to a line nobody is
      // typing any more is worse than none.
      if (text === '' || text === 'undefined' || server.line !== line) return;
      // Typing `42` and being told `42` is not information.
      if (text === line.trim()) return;
      const width = room(line);
      if (width < PREVIEW_MINIMUM_WIDTH) return;

      draw(truncate(value, width));
    });
  };

  const draw = (value: string) => {
    const columns = (server.output as NodeJS.WriteStream).columns ?? 0;
    const cursor = plainLength(server.getPrompt()) + (server.cursor ?? 0) + 1;
    const at = columns - plainLength(value) + 1;
    // Out to the right margin and back to where the cursor was, in one write, so nothing is ever
    // on screen with the caret in the wrong place. Erased by readline's own redraw on the next
    // keystroke, which clears from the cursor to the end of the screen.
    server.output.write(`${ESCAPE}[${at}G${value}${ESCAPE}[0m${ESCAPE}[${cursor}G`);
  };

  server.input.on('keypress', () => {
    clearTimeout(timer);
    // After a pause in the typing, not during it: every request is a round trip to the page, and
    // the answer to a line half typed is thrown away by the next keystroke anyway.
    timer = setTimeout(ask, PREVIEW_DELAY_MS);
    // Never the reason the process stays alive.
    timer.unref();
  });
}

/**
 * What to SAY when the page has gone — the farewell, not the going.
 *
 * There is nothing to recover and nothing to offer: a REPL's whole value is the page it is holding
 * — the bindings, the DOM, the module state — and all of it went at once. Reopening one would not
 * bring any of it back; it would be the session you get by running the command again, which the
 * shell already remembers. So the message says what was lost and what to type, and the caller ends
 * the process rather than sitting at a prompt that cannot answer anything.
 *
 * ```ts
 * import { pageGoneMessage } from './index.ts';
 *
 * pageGoneMessage(['node', 'cli.ts', 'repl', 'a.ts']).includes('qunitx repl a.ts'); // true
 * ```
 */
export function pageGoneMessage(argv: readonly string[] = process.argv): string {
  const again = argv.slice(2).join(' ');

  return [
    'the page is gone — the browser closed, crashed, or was killed.',
    'Everything it was holding went with it, so there is nothing here to carry on with.',
    again === '' ? 'Run qunitx repl again to start over.' : `Start again with: qunitx ${again}`,
  ].join('\n');
}

/**
 * Runs one shell command, streaming its output to the terminal as it arrives.
 *
 * Through a shell on purpose: `:` means "the thing I would have typed in another window", and
 * pipes, globs and `&&` are most of what that is. The command comes from the person at the prompt,
 * for their own machine — there is nothing here to protect them from that they could not type
 * directly. It runs in the session's working directory, so relative paths mean what `.cat` means.
 *
 * The child is handed this process's own stdout and stderr rather than a pipe copied across, which
 * is what makes `:git status` and `:ls` come out in colour: every tool decides whether to colour by
 * asking whether it is talking to a terminal, and a pipe answers no. It is also what makes a
 * progress bar work, and what keeps a build that prints for a minute printing for a minute rather
 * than arriving at the end. Piped in, piped out — a scripted session still gets plain text, for the
 * same reason and by the same rule.
 *
 * `out` is left for the one message that is this REPL's rather than the command's: a command that
 * will not start at all.
 *
 * ```ts
 * import { shell } from './index.ts';
 *
 * // Defined, not invoked: it starts a real process.
 * function example(out: NodeJS.WritableStream) {
 *   return shell('git status --short', out, process.cwd()); // resolves with the exit code
 * }
 * ```
 */
export function shell(command: string, out: NodeJS.WritableStream, cwd: string): Promise<number> {
  const trimmed = command.trim();
  if (trimmed === '') return Promise.resolve(0);

  return new Promise((resolve) => {
    // stdin stays closed: the terminal's is being read by the prompt, and two readers of one
    // keyboard is a session that loses keystrokes. `.edit` is the way to hand a command the tty.
    const child = spawn(trimmed, { shell: true, cwd, stdio: ['ignore', 'inherit', 'inherit'] });
    // A command that will not start is an answer about the command, not a crash of the session.
    child.on('error', (error: Error) => {
      out.write(red(`${error.message}\n`));
      resolve(127);
    });
    child.on('close', (code) => resolve(code ?? 0));
  });
}
