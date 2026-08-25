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
import type { ReplSession } from '../repl/session.ts';
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
      // The session already rendered the value, in the page, with the page's own view of it.
      writer: (value: unknown) => String(value),
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
        session.evaluate(source).then(
          (result) => {
            evaluating = false;
            // What `node:repl` reads as "keep the line open and ask for the next one".
            if (result.incomplete) {
              return callback(new nodeRepl.Recoverable(new Error('unfinished input')), undefined);
            }
            // A pause is not a value and not a failure — it is the page stopping and waiting.
            // Said plainly, with the way out, because a prompt that just returns leaves someone
            // wondering why the next line behaves strangely.
            if (result.pausedAt) {
              server.output.write(
                blue(`paused at ${result.pausedAt} — locals are in scope; .resume to continue\n`),
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

    setupHistory(server, interactive);
    server.defineCommand('reload', {
      help: 'Reload the page — drops every binding and all page state',
      action() {
        this.clearBufferedCommand();
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

    // `.cat` and `.view` are the same command under both names — `cat` for the muscle memory,
    // `view` for anyone who does not have it. A REPL is where you check what a file actually says
    // before typing against it, and leaving the session to do that loses every binding you built.
    for (const name of ['cat', 'view']) {
      server.defineCommand(name, {
        help: 'Print a file, resolved against the working directory',
        action(file: string) {
          this.clearBufferedCommand();
          const target = file.trim();
          if (target === '') this.output.write(`Usage: .${name} <file>\n`);
          else {
            const resolved = path.resolve(cwd, target);
            const contents = tryReadFile(resolved);
            this.output.write(
              contents === null
                ? red(`${path.relative(cwd, resolved) || target}: no such file\n`)
                : contents.endsWith('\n')
                  ? contents
                  : `${contents}\n`,
            );
          }
          this.displayPrompt();
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
    server.defineCommand('resume', {
      help: 'Let a page paused at a `debugger` statement carry on',
      action() {
        this.clearBufferedCommand();
        if (!session.pausedAt) this.output.write('Not paused\n');
        void session.resume().then(() => this.displayPrompt());
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
    // Whatever the editor left in the buffer is the editor's, not the next line's — a half-read
    // escape sequence typed at a prompt is the garbage this whole handover exists to avoid.
    while (stdin.read() !== null) {
      // Discarding, deliberately.
    }
    stdin.resume();
    server.resume();
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone, which is where it was headed.
    }
  }
}
