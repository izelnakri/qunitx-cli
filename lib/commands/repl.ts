import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import nodeRepl, { type REPLServer } from 'node:repl';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import * as Args from '../args/index.ts';
import * as Config from '../setup/config.ts';
import * as Reporter from '../reporters/index.ts';
import * as Repl from '../repl/session.ts';
import * as Result from '../result/index.ts';
import { blue, red } from '../utils/color.ts';
import { findProjectRoot } from '../utils/find-project-root.ts';
import { formatScope } from '../repl/scope.ts';
import * as Files from '../repl/files.ts';
import { plain, plainLength, truncate } from '../repl/columns.ts';
import { depth, highlight } from '../repl/highlight.ts';
import { theme } from '../repl/theme.ts';
import { split, suggest } from '../repl/suggest.ts';
import type { ReplSession } from '../repl/session.ts';
import type { Theme } from '../repl/theme.ts';
import type { Config as ResolvedConfig } from '../types.ts';

const PROMPT = '> ';
const HISTORY_FILE = '.qunitx_repl_history';

/**
 * Runs `qunitx repl`: opens a browser page, then reads, evaluates and prints in it until the input
 * ends. Resolves with the process exit code once everything is closed.
 *
 * ```ts
 * import * as ReplCommand from './repl.ts';
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

  return await drive(session, config.cwd);
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
function drive(session: ReplSession, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const interactive = Boolean(process.stdin.isTTY);
    // Piped input goes through a stream this process fills one line at a time. Feeding the REPL
    // `process.stdin` directly delivers the whole pipe in one chunk, and readline then emits every
    // line synchronously — so `echo $'1+1\n2+2' | qunitx repl` started both evaluations at once and
    // reached EOF before either answered. A terminal keeps the real stdin: raw mode, keypresses
    // and history need a TTY, and a human cannot type faster than the page can answer.
    const input = interactive ? vimKeys(process.stdin) : new PassThrough();
    let evaluating = false;
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

              return callback(null, undefined);
            }
            const text = result.failed ? red(`Uncaught ${result.output}`) : result.output;

            return callback(null, text === '' ? undefined : text);
          },
          (error: Error) => {
            evaluating = false;
            callback(error, undefined);
          },
        );
      },
    });

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
    server.defineCommand('break', {
      help: 'Abandon the unfinished input',
      action() {
        buffered = '';
        this.clearBufferedCommand();
        this.displayPrompt();
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
    server.defineCommand('history', {
      help: 'Show the last lines entered — `.history 40` for more of them',
      action(count: string) {
        this.clearBufferedCommand();
        const asked = count.trim() === '' ? HISTORY_SHOWN : Number(count.trim());
        if (!Number.isInteger(asked) || asked < 1) {
          this.output.write(`Usage: .history [count]\n`);

          return void this.displayPrompt();
        }
        const entries = (server as unknown as { history?: string[] }).history ?? [];
        this.output.write(recent(entries, asked, palette));
        this.displayPrompt();
      },
    });

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
              const text = result.failed ? red(`Uncaught ${result.output}`) : result.output;
              if (text !== '') this.output.write(`${text}\n`);
            }
            this.displayPrompt();
          });
        },
      });
    }

    // `.cat` for the muscle memory, `.view` for anyone without it — but they stopped being the
    // same command once a directory became something worth looking at. `cat` on a directory is an
    // error everywhere, so it stays one here; `.view` shows whatever is there.
    for (const name of ['cat', 'view']) {
      server.defineCommand(name, {
        help:
          name === 'cat'
            ? 'Print a file, numbered and highlighted'
            : 'Show a file numbered, or a directory as a tree (`-L 2` to limit the depth)',
        action(argument: string) {
          this.clearBufferedCommand();
          const { depth, path: typed } = Files.target(argument.trim());
          if (argument.trim() === '') {
            this.output.write(`Usage: .${name} <file>\n`);

            return void this.displayPrompt();
          }

          const found = Files.read(typed, cwd);
          if (found.kind === 'file') {
            this.output.write(`${Files.numbered(found.contents, typed, palette)}\n`);

            return void this.displayPrompt();
          }
          if (found.kind === 'directory' && name === 'view') {
            this.output.write(showTree(typed, cwd, palette, depth));

            return void this.displayPrompt();
          }
          // Everything else leaves the prompt holding the part that WAS real, so the next attempt
          // is a few keystrokes and not the whole path again. TAB and the suggestion take it from
          // there.
          this.output.write(red(`${pathProblem(found, typed)}\n`));
          this.displayPrompt();
          if (found.kind !== 'unreadable' && interactive) server.write(`.${name} ${found.retype}`);
        },
      });
    }
    // Only ever a tree, so `.tree` on a file says so rather than quietly printing it. Half the
    // value of a narrow command is that it refuses what it is not for.
    server.defineCommand('tree', {
      help: 'Show a directory as a tree — `-L 2` for two levels, all the way down by default',
      action(argument: string) {
        this.clearBufferedCommand();
        const { depth, path: typed } = Files.target(argument.trim());
        const found = Files.read(typed, cwd);
        if (found.kind === 'directory') {
          this.output.write(showTree(typed, cwd, palette, depth));
        } else if (found.kind === 'file') {
          this.output.write(red(`${typed} is a file, not a directory\n`));
        } else {
          this.output.write(red(`${pathProblem(found, typed)}\n`));
          this.displayPrompt();

          return void (
            found.kind === 'missing' &&
            interactive &&
            server.write(`.tree ${found.retype}`)
          );
        }
        this.displayPrompt();
      },
    });
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
    // `.continue` is the name every debugger uses for this, and the one the pause itself offers.
    // `.resume` stays because it is what this REPL shipped with, and a command that used to work
    // should not stop working over a rename.
    for (const name of ['continue', 'resume']) {
      server.defineCommand(name, {
        help: 'Let a page paused at a `debugger` statement carry on',
        action() {
          this.clearBufferedCommand();
          if (!session.pausedAt) this.output.write('Not paused\n');
          void session.resume().then(() => this.displayPrompt());
        },
      });
    }
    // Two commands rather than one because a REPL is in one of two states and the answer differs:
    // running, where the interesting names are the ones this session added to the page, and
    // stopped at a breakpoint, where they are the ones the frame can see. Same format either way.
    server.defineCommand('scope', {
      help: 'List what this session has added to the page, with values',
      action() {
        this.clearBufferedCommand();
        void session.scope().then((entries) => {
          const listing = formatScope(entries, terminalWidth(this.output));
          this.output.write(listing === '' ? 'Nothing declared yet\n' : `${listing}\n`);
          this.displayPrompt();
        });
      },
    });
    server.defineCommand('locals', {
      help: 'List what is in scope at a `debugger` breakpoint, with values',
      action() {
        this.clearBufferedCommand();
        if (!session.pausedAt) {
          this.output.write('Not paused — `.scope` is what this session has declared\n');

          return void this.displayPrompt();
        }
        void session.locals().then((entries) => {
          const listing = formatScope(entries, terminalWidth(this.output));
          this.output.write(listing === '' ? 'Nothing in scope here\n' : `${listing}\n`);
          this.displayPrompt();
        });
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
          () => resolve(0),
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

/**
 * Points history at `~/.qunitx_repl_history`, honouring `QUNITX_REPL_HISTORY` (an empty value
 * turns it off). Only in a terminal — `setupHistory` is a no-op without one, and a scripted
 * invocation has no business writing to a history file.
 */
function setupHistory(server: REPLServer, interactive: boolean): void {
  const configured = process.env.QUNITX_REPL_HISTORY;
  if (!interactive || configured === '') return;
  const file = configured || path.join(os.homedir(), HISTORY_FILE);
  // A history file that cannot be written is worth knowing about, not worth refusing to start
  // over, and never worth a stack trace on top of the banner.
  server.setupHistory(file, (error) => {
    if (error) server.output.write(`# qunitx repl: history disabled (${error.message})\n`);
  });
  // `node:repl` writes the whole history at position 0 and never shortens the file, so a write
  // that is smaller than the one before it leaves the tail of the old one behind. The file is
  // newest first, so that tail lands on the END of the oldest entry and becomes part of it —
  // which is how a history line grows into `.localsstring()nan() { … }orle(4) should be 9')))'`,
  // a dozen half-lines glued into one. It survives every restart, and it is offered as a
  // suggestion the moment you type anything it happens to start with.
  server.on('flushHistory', () => {
    trimHistoryFile(file, (server as unknown as { history?: string[] }).history ?? []);
  });
}

/**
 * Cuts the history file back to the history it is meant to hold.
 *
 * Only ever SHORTENS. Growing a file with `truncate` pads it with zero bytes, and a history file
 * full of NULs is a worse problem than the one this solves — so a file that is already the right
 * size, or somehow shorter, is left exactly as it is.
 *
 * Best-effort throughout: a history file is a convenience, and no failure to tidy one is worth
 * interrupting a session over.
 *
 * ```ts
 * import { trimHistoryFile } from './repl.ts';
 *
 * trimHistoryFile('/nonexistent/history', ['a']); // does nothing, says nothing
 * ```
 */
export function trimHistoryFile(file: string, history: readonly string[]): void {
  const wanted = Buffer.byteLength(history.join('\n'), 'utf8');
  try {
    if (fs.statSync(file).size > wanted) fs.truncateSync(file, wanted);
  } catch {
    // Gone, unreadable, or not ours to tidy.
  }
}

/** A file's contents, or null when it cannot be read — a missing path is an answer, not a crash. */
function tryReadFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Ctrl-K and Ctrl-J as their raw bytes, and the arrows readline already understands.
const CTRL_K = 0x0b;
const CTRL_J = 0x0a;
const ARROW_UP = '\u001b[A';
const ARROW_DOWN = '\u001b[B';
const ESCAPE = String.fromCharCode(27);
// SGR mouse (`ESC [ < … M|m`), legacy mouse (`ESC [ M` plus three bytes), and cursor position
// (`ESC [ … R`). Built rather than written as literals: a regex literal holding a real escape
// character is exactly what the linter refuses, and it is right to.
const REPORTS = [
  new RegExp(`${ESCAPE}\\[<\\d+;\\d+;\\d+[Mm]`, 'g'),
  new RegExp(`${ESCAPE}\\[M[\\s\\S]{3}`, 'g'),
  new RegExp(`${ESCAPE}\\[\\d+;\\d+R`, 'g'),
];

/**
 * Walks history with Ctrl-K and Ctrl-J, by rewriting the bytes before readline sees them.
 *
 * Rewritten rather than handled, for two reasons a keypress listener cannot get around. Ctrl-K
 * already means kill-to-end-of-line, and a second listener does not replace readline's — it runs
 * as well, so the line would be shredded on the way to the previous entry. And Ctrl-J is not a
 * distinguishable key at all: it arrives as `\n`, which readline reads as Enter and every
 * multi-line paste is full of. Binding it by name would stop pastes submitting.
 *
 * The paste is what the single-byte test is for. A keystroke arrives on its own; a paste arrives
 * as a chunk, so a `\n` with company is left exactly as it was and still submits its line.
 *
 * The returned stream stands in for the TTY it wraps — readline needs `isTTY` and `setRawMode` to
 * put the terminal in the mode this depends on, and neither belongs to a plain PassThrough.
 *
 * ```ts
 * import { PassThrough } from 'node:stream';
 * import { vimKeys } from './repl.ts';
 *
 * const stdin = Object.assign(new PassThrough(), { setRawMode: () => {} });
 * vimKeys(stdin as unknown as NodeJS.ReadStream).isTTY; // true — readline needs to believe it
 * ```
 */
export function vimKeys(stdin: NodeJS.ReadStream): NodeJS.ReadStream {
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
 * Drops the terminal's answers to itself: mouse reports and cursor-position reports.
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
 * import { withoutTerminalReports } from './repl.ts';
 *
 * const ESC = String.fromCharCode(27);
 * withoutTerminalReports(Buffer.from(`a${ESC}[<32;14;45Mb`)).toString(); // 'ab'
 * withoutTerminalReports(Buffer.from('1 + 1')).toString(); // '1 + 1' — ordinary typing is untouched
 * ```
 */
export function withoutTerminalReports(chunk: Buffer): Buffer {
  const text = chunk.toString('binary');
  if (!text.includes(ESCAPE)) return chunk;

  const stripped = REPORTS.reduce((rest, report) => rest.replace(report, ''), text);

  return stripped === text ? chunk : Buffer.from(stripped, 'binary');
}

/**
 * Runs one shell command, streaming its output to the terminal as it arrives.
 *
 * Through a shell on purpose: `:` means "the thing I would have typed in another window", and
 * pipes, globs and `&&` are most of what that is. The command comes from the person at the prompt,
 * for their own machine — there is nothing here to protect them from that they could not type
 * directly. It runs in the session's working directory, so relative paths mean what `.cat` means.
 *
 * Streamed rather than collected: a command worth running from here is often one worth watching,
 * and a build that prints for a minute should print for a minute.
 *
 * ```ts
 * import { shell } from './repl.ts';
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
    const child = spawn(trimmed, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => out.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => out.write(chunk));
    // A command that will not start is an answer about the command, not a crash of the session.
    child.on('error', (error: Error) => {
      out.write(red(`${error.message}\n`));
      resolve(127);
    });
    child.on('close', (code) => resolve(code ?? 0));
  });
}

/**
 * The lines of a session worth replaying: everything typed, minus the shell escapes.
 *
 * `lines` is `node:repl`'s own record of what it evaluated and is absent from `@types/node`'s
 * `REPLServer`, so it is reached through a narrow cast rather than by widening the whole server.
 *
 * ```ts
 * import { replayableLines } from './repl.ts';
 *
 * replayableLines({ lines: ['1 + 1', ':git status', '2 + 2'] }); // ['1 + 1', '2 + 2']
 * ```
 */
export function replayableLines(server: { lines?: string[] }): string[] {
  return (server.lines ?? []).filter((line) => !line.trimStart().startsWith(':'));
}

/** True when the file was written. A save that cannot land is a message, not a crashed session. */
function tryWriteFile(file: string, contents: string): boolean {
  try {
    fs.writeFileSync(file, contents);

    return true;
  } catch {
    return false;
  }
}

/**
 * Hands the terminal to an editor, and takes back whatever was saved.
 *
 * The REPL is holding the TTY in raw mode with a readline attached, and an editor needs both back.
 * Three things have to happen, and the middle one is the one that bites.
 *
 * `server.pause()` stops readline. `stdin.pause()` stops NODE reading fd 0 — without it both this
 * process and the editor read the same descriptor and race for every byte. nvim loses keystrokes,
 * and its terminal reports arrive at the prompt instead of at nvim: `32;14;45M` and friends, which
 * are SGR mouse events, spilling into the line after a session that looked fine until you quit.
 * Raw mode is lifted last, because the editor sets whatever modes it wants and restores them on
 * exit; anything still owned by Node at that point is what survives to corrupt the next line.
 *
 * NOT `detached`. A detached child leads its own process group, which is not the terminal's
 * foreground group — the first read from the TTY would stop it with SIGTTIN. Inheriting the
 * terminal while its reader stands down is what "it owns the screen" actually means here.
 *
 * The buffer travels through a file because that is the only thing an editor talks. It comes back
 * as a string, and the CALLER keeps it: the session's scratchpad lives for as long as the session,
 * so reopening continues the same thought rather than starting a blank one.
 *
 * A `.js` extension, because whatever an editor does with syntax and indentation should be what it
 * would do for the file this text is going to behave like.
 *
 * ```ts
 * import type { REPLServer } from 'node:repl';
 * import { edit } from './repl.ts';
 *
 * // Defined, not invoked: it takes over the terminal.
 * function example(server: REPLServer) {
 *   return edit('vi', 'const x = 1;', server); // resolves with whatever was saved
 * }
 * ```
 */
export async function edit(editor: string, contents: string, server: REPLServer): Promise<string> {
  // Unique per call, not per process: two edits in flight at once would otherwise open the same
  // path and each would save over the other's buffer.
  const file = path.join(os.tmpdir(), `qunitx-repl-${process.pid}-${randomUUID()}.js`);
  fs.writeFileSync(file, contents);
  server.pause();
  const stdin = process.stdin;
  const wasRaw = Boolean(stdin.isRaw);
  // Both halves of how stdin was found, because both have to be put back. Resuming a stream that
  // was not flowing does not restore anything — it STARTS something, and a flowing stdin holds the
  // event loop open for as long as the process lives. `readableFlowing` and not `isPaused()`:
  // a stdin nobody has read yet is neither flowing nor paused, and `isPaused()` calls that false.
  const wasFlowing = stdin.readableFlowing === true;
  stdin.pause();
  if (wasRaw) stdin.setRawMode(false);

  try {
    await new Promise<void>((resolve) => {
      const child = spawn(editor, [file], { stdio: 'inherit' });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    });

    return tryReadFile(file) ?? contents;
  } finally {
    if (wasRaw) stdin.setRawMode(true);
    // Handing the terminal back, and only to a prompt that had it. Whatever the editor left in the
    // buffer is the editor's, not the next line's — a half-read escape sequence typed at a prompt
    // is the garbage this whole handover exists to avoid. Where nothing was reading stdin, neither
    // half applies: `read()` restarts the flow it drains, and a stdin left flowing with no reader
    // holds the event loop open for the life of the process.
    if (wasFlowing) {
      while (stdin.read() !== null) {
        // Discarding, deliberately.
      }
      stdin.resume();
    }
    server.resume();
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone, which is where it was headed.
    }
  }
}

/**
 * A directory drawn, with the tally `tree` prints under one — and with whatever the cap left out.
 *
 * Said outright rather than trimmed in silence: a listing that stops without saying so reads as
 * the whole answer, and the way to get the rest is the flag it names.
 */
function showTree(typed: string, cwd: string, palette: Theme, depth: number): string {
  const { listing, counted, omitted } = Files.tree(typed, cwd, palette, depth);
  const tally = `${counted.directories} directories, ${counted.files} files`;
  const cut = omitted === 0 ? '' : ` — ${omitted} more not shown, \`-L\` to narrow`;

  return `${listing}\n\n${tally}${cut}\n`;
}

/** Why a path did not open, in one line. */
function pathProblem(found: Exclude<Files.Resolution, { kind: 'file' }>, target: string): string {
  if (found.kind === 'directory') return `${target} is a directory`;
  if (found.kind === 'missing') {
    return found.retype === ''
      ? `no such file: ${target}`
      : `no such file: ${target} — ${found.retype} exists`;
  }

  return `cannot read ${target}: ${found.detail}`;
}

/** How wide a line may be. 80 where nothing says — a pipe has no width, and neither does a file. */
function terminalWidth(output: NodeJS.WritableStream): number {
  return (output as NodeJS.WriteStream).columns || 80;
}

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
 * What the line would come to, drawn dimmed against the right margin while it is still being typed.
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
 * import { setupPreview } from './repl.ts';
 *
 * import type { REPLServer } from 'node:repl';
 * import type { ReplSession } from '../repl/session.ts';
 *
 * // Defined, not invoked: it evaluates in a live page and draws on a live terminal.
 * function example(server: REPLServer, session: ReplSession) {
 *   setupPreview(server, session, () => false); // never busy, nothing else on the row
 * }
 * ```
 */
export function setupPreview(
  server: REPLServer,
  session: ReplSession,
  busy: () => boolean,
  reserved: () => string = () => '',
): void {
  let timer: NodeJS.Timeout | undefined;

  const room = (line: string): number => {
    const columns = (server.output as NodeJS.WriteStream).columns ?? 0;
    // The suggestion counts: it is drawn after the cursor on this same row, and a preview that
    // ignores it lands on top of the tail of what it is offering.
    const used = plainLength(server.getPrompt()) + line.length + plainLength(reserved());
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
      !busy() &&
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
 * Paints the line as it is typed, in the colours the theme gives each capture.
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
 * import { setupHighlighting } from './repl.ts';
 * import { theme } from '../repl/theme.ts';
 *
 * import type { REPLServer } from 'node:repl';
 *
 * // Defined, not invoked: it draws on a live terminal.
 * function example(server: REPLServer) {
 *   setupHighlighting(server, theme());
 * }
 * ```
 */
export function setupHighlighting(server: REPLServer, palette: Theme): void {
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

/** Ctrl-F, the key that takes the suggestion. */
const CTRL_F = '\u0006';
/** How many lines `.history` shows when it is not told — the number zsh settled on. */
const HISTORY_SHOWN = 16;
/** And how many the session keeps at all, which has to be the larger number of the two. */
const HISTORY_KEPT = 1_000;

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

/**
 * The last `count` lines entered, numbered, the way `history` prints them.
 *
 * Oldest first, so the newest is nearest the prompt — reading up from where you are is how anybody
 * uses this. Numbered from one across what the session has, which is what it can honestly count:
 * history older than the file it was loaded from is not here to be numbered.
 *
 * ```ts
 * import { recent } from './repl.ts';
 *
 * recent(['b', 'a'], 2, { style: () => '' }); // '1  a\n2  b\n' — newest last
 * recent([], 16, { style: () => '' }); // '' — nothing entered yet
 * ```
 */
export function recent(newestFirst: readonly string[], count: number, palette: Theme): string {
  const oldestFirst = [...newestFirst].reverse();
  const from = Math.max(0, oldestFirst.length - count);
  const gutter = String(oldestFirst.length).length;
  const style = palette.style('LineNr');

  return oldestFirst
    .slice(from)
    .map((line, index) => {
      const number = String(from + index + 1).padStart(gutter);

      // A dot command and a `:` shell line are not JavaScript, and painting them as if they were
      // colours `-L` as a type and `git` as a call.
      const code = /^\s*[.:]/.test(line) ? line : highlight(line, palette);

      return `${style === '' ? number : `${style}${number}${ESCAPE}[0m`}  ${code}\n`;
    })
    .join('');
}

/** What `node:repl` hands a completer to answer through: the matches, and the word they finish. */
type CompleterCallback = (error: null, result: [string[], string]) => void;

/**
 * The page's identifiers, as something a keystroke can read.
 *
 * Completion has to be instant and the answer lives in another process, so this keeps the last one
 * and asks for the next in the background. A miss is not a stall: {@link NameSource.lookup} says
 * what it knows now, the request lands a moment later, and subscribers redraw with the answer.
 *
 * Going stale is deliberately not the same as being emptied. An evaluation may have declared a
 * name, but everything already known is still true, so the old list stays on offer until the new
 * one arrives rather than suggestions blinking out after every line.
 */
interface NameSource {
  /** Names on `base` as of the last answer — empty while the first one is in flight. */
  lookup(base: string): readonly string[];
  /** The page's answer for `base`, waited for. What TAB uses, where a moment is affordable. */
  ask(base: string): Promise<readonly string[]>;
  /** Marks every answer worth asking for again. */
  stale(): void;
  /** Called whenever a late answer arrives, so what is on screen can be drawn again. */
  subscribe(listener: () => void): void;
}

function completionCache(session: ReplSession): NameSource {
  const known = new Map<string, readonly string[]>();
  // Which answers describe the page as it is NOW. Separate from having an answer at all, because
  // the two differ for exactly as long as a refresh takes — which is when the old one is useful.
  const current = new Set<string>();
  const inFlight = new Map<string, Promise<readonly string[]>>();
  const listeners: Array<() => void> = [];
  let generation = 0;

  const fetch = (base: string): Promise<readonly string[]> => {
    const pending = inFlight.get(base);
    if (pending) return pending;
    const asked = generation;
    const request = session
      .names(base)
      .catch((): string[] => [])
      .then((names) => {
        inFlight.delete(base);
        known.set(base, names);
        // A `.reload` while this was in flight makes the answer describe a page that is gone. It
        // is still the best thing available, so it is kept — just not called current, which is
        // what sends the next keystroke to ask again.
        if (asked === generation) current.add(base);
        for (const listener of listeners) listener();

        return names;
      });
    inFlight.set(base, request);

    return request;
  };

  return {
    lookup(base) {
      if (!current.has(base)) void fetch(base);

      return known.get(base) ?? [];
    },
    ask(base) {
      const answer = known.get(base);

      return current.has(base) && answer ? Promise.resolve(answer) : fetch(base);
    },
    stale() {
      current.clear();
      generation++;
    },
    subscribe(listener) {
      listeners.push(listener);
    },
  };
}

/**
 * What TAB offers: dot commands on a line that starts with one, page identifiers everywhere else.
 *
 * Nothing is offered where {@link split} finds no base it is willing to evaluate — `foo().b` needs
 * `foo()` called to know what is on it, and TAB is not consent to run somebody's function.
 *
 * ```ts
 * import { complete } from './repl.ts';
 *
 * import type { REPLServer } from 'node:repl';
 *
 * // Defined, not invoked: the names come from a live page.
 * function example(server: REPLServer) {
 *   const names = {
 *     lookup: () => ['title'],
 *     ask: () => Promise.resolve(['title']),
 *     stale: () => {},
 *     subscribe: () => {},
 *   };
 *   complete(server, names, 'document.ti', (_error, [hits]) => hits); // ['title']
 * }
 * ```
 */
export function complete(
  server: REPLServer,
  names: NameSource,
  line: string,
  callback: CompleterCallback,
  cwd: string = process.cwd(),
): void {
  // A path line completes like a shell, because that is what is being typed on it.
  const typedPath = Files.fragment(line);
  if (typedPath !== null) return callback(null, [Files.complete(typedPath, cwd), typedPath]);

  const typed = line.trimStart();
  if (typed.startsWith('.')) {
    const partial = typed.slice(1);
    const commands = Object.keys(server.commands ?? {})
      .filter((name) => name.startsWith(partial))
      .sort()
      .map((name) => `.${name}`);

    return callback(null, [commands, typed]);
  }

  const position = split(line);
  if (!position) return callback(null, [[], line]);

  void names.ask(position.base).then((found) => {
    const hits = found.filter((name) => name.startsWith(position.token)).sort();

    return callback(null, [hits, position.token]);
  });
}

/**
 * zsh-style typeahead: the rest of the last matching line, greyed out after the cursor, Ctrl-F to
 * take it.
 *
 * Drawn AFTER readline has drawn, on the tick following each keypress. readline draws on that same
 * keypress and would paint over anything written first; the ghost is appended to its output and
 * the cursor walked back over it, so the line readline believes it has is the line it has. Nothing
 * here touches `server.line`, which is why an unaccepted suggestion cannot end up in what gets
 * evaluated.
 *
 * ```ts
 * import { setupSuggestions } from './repl.ts';
 *
 * import type { REPLServer } from 'node:repl';
 *
 * // Defined, not invoked: it listens on a live terminal.
 * function example(server: REPLServer) {
 *   setupSuggestions(server); // ghost text on, Ctrl-F accepts
 * }
 * ```
 */
export function setupSuggestions(
  server: REPLServer,
  names?: NameSource,
  cwd: string = process.cwd(),
): () => string {
  const style = suggestionStyle();
  const internals = server as unknown as { _writeToOutput(text: string): void };
  const write = internals._writeToOutput.bind(server);

  internals._writeToOutput = (text: string) => {
    // Submitting the line. readline has just moved the cursor to the end of it and is about to
    // leave that row behind for good — and the suggestion is drawn exactly there, so without this
    // it stays on screen as part of what was typed: `me` submitted under a suggestion of
    // `menubar` is echoed back as `menubar`. Nothing else erases it, because everything else that
    // does erases by redrawing the line, and this row is never drawn again.
    return write(text === '\r\n' ? `${ESCAPE}[0J\r\n` : text);
  };
  // What would be taken right now, derived from the line as it stands. Nothing is remembered
  // between keystrokes: a ghost held in a variable outlives the line it was computed for — across
  // `.nvim`, which reads no keys for as long as the editor is open — and Ctrl-F would then insert
  // the tail of a line nobody is typing. Twice through the history is not a cost worth a bug.
  const suggestion = (): string => {
    const line = server.line ?? '';
    // Only at the end of the line. A suggestion continues what is being typed, and there is no
    // such thing as continuing the middle of a line — nor anywhere safe to draw it.
    if (server.cursor !== line.length) return '';
    // `history` is readline's own record, newest first, and absent from `@types/node`'s REPLServer
    // — reached through a narrow cast rather than by widening the whole server.
    const history = (server as unknown as { history?: string[] }).history ?? [];
    // A path line is answered from the filesystem — the only place that knows — and never from
    // history, where `.cat` lines are as likely to be about a file that has since been renamed.
    const asPath = Files.suggest(line, cwd);
    if (asPath !== '' || Files.fragment(line) !== null) return asPath;

    const position = split(line);

    return suggest(line, {
      names: position && names ? names.lookup(position.base) : [],
      history,
    });
  };

  const draw = () => {
    // Mid-line there is real text after the cursor, so there is nothing to draw and — the part
    // that matters — nothing may be erased.
    if (server.cursor !== (server.line ?? '').length) return;
    const ghost = suggestion();
    // ERASED, not painted over. readline appends a typed character in place rather than redrawing
    // the line, so the previous suggestion is still on screen with only its first character
    // covered: type `d` then `o` and the tail of what `d` suggested trails the line. `[0J` clears
    // from the cursor to the end of the screen, which is the same thing readline's own redraw
    // uses, and is what handles a suggestion long enough to have wrapped.
    const cleared = `${ESCAPE}[0J`;
    if (ghost === '') return void server.output.write(cleared);
    // Written and then stepped back over: the cursor must end where readline left it, or the next
    // keystroke lands in the wrong column.
    server.output.write(`${cleared}${style}${ghost}${ESCAPE}[0m${ESCAPE}[${ghost.length}D`);
  };

  // A name that arrives after the keystroke that needed it still gets drawn, on the line it was
  // asked for — `draw` reads the line as it stands, so one that has moved on simply draws itself.
  names?.subscribe(draw);
  let scheduled = false;
  server.input.on('keypress', (sequence: string) => {
    // Through `write`, so readline inserts it the way it inserts typing — its own line state, its
    // own redraw, and the suggestion becomes ordinary text that can be edited.
    if (sequence === CTRL_F) {
      const taken = suggestion();
      if (taken !== '') server.write(taken);
    }
    // After readline: it redraws on this same keypress, and drawing first would be drawing under
    // paint that has not dried. At most once a tick, so a paste draws one suggestion and not one
    // per character.
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      draw();
    });
  });

  // What is on screen after the cursor, for anything else drawing on the same row.
  return suggestion;
}

/**
 * The escape sequence a suggestion is drawn in, muted the way zsh mutes its own.
 *
 * Read from the environment rather than guessed at, because "muted" against a light terminal and
 * against a dark one are different colours and only the developer knows which they are on.
 * `QUNITX_SUGGEST_STYLE` is the direct spelling; `ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE` is honoured when
 * it has been exported, since somebody running zsh has already answered this question once.
 *
 * ```ts
 * import { suggestionStyle } from './repl.ts';
 *
 * suggestionStyle().startsWith(String.fromCharCode(27)); // true — an SGR sequence either way
 * ```
 */
export function suggestionStyle(): string {
  const configured =
    process.env.QUNITX_SUGGEST_STYLE ?? process.env.ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE;
  const colour = configured?.match(/fg=#?([0-9a-fA-F]{6}|\d{1,3})/)?.[1];
  if (!colour) return `${ESCAPE}[90m`;

  // `fg=8` is a palette index, `fg=#585858` is a truecolour triple — zsh writes both.
  if (/^\d{1,3}$/.test(colour)) return `${ESCAPE}[38;5;${colour}m`;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(colour.slice(at, at + 2), 16));

  return `${ESCAPE}[38;2;${r};${g};${b}m`;
}
