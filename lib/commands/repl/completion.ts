import process from 'node:process';
import { ESCAPE, plainLength } from '../../repl/terminal.ts';
import fs from 'node:fs';
import path from 'node:path';
import { split, suggest as suggestFromNames } from '../../repl/suggest.ts';
import type { REPLServer } from 'node:repl';
import type { ReplSession } from '../../repl/session.ts';

/** What `node:repl` hands a completer to answer through: the matches, and the word they finish. */
/** Ctrl-F, the key that takes the suggestion. */
const CTRL_F = '\u0006';

/**
 * What `node:repl` hands a completer to answer through: the matches, and the word they finish.
 *
 * ```ts
 * import type { CompleterCallback } from './completion.ts';
 *
 * const answer: CompleterCallback = (_error, [hits]) => hits.length; // ['a'] finishes 'a'
 * ```
 */
export type CompleterCallback = (error: null, result: [string[], string]) => void;

/**
 * The page's identifiers, as something a keystroke can read.
 *
 * Completion has to be instant and the answer lives in ANOTHER PROCESS — `session.completions()`
 * is a CDP round trip to a browser — so this keeps the last answer and asks for the next in the
 * background. That is the whole reason it exists, and the reason it is a cache rather than a
 * lookup: a miss is not a stall. {@link CompletionCache.lookup} says what it knows right now, the
 * request lands a moment later, and subscribers redraw with the answer.
 *
 * Going stale is deliberately not the same as being emptied. An evaluation may have declared a
 * name, but everything already known is still true, so the old list stays on offer until the new
 * one arrives rather than suggestions blinking out after every line.
 */
export interface CompletionCache {
  /** Names on `base` as of the last answer — empty while the first one is in flight. */
  lookup(base: string): readonly string[];
  /** The page's answer for `base`, waited for. What TAB uses, where a moment is affordable. */
  ask(base: string): Promise<readonly string[]>;
  /** Marks every answer worth asking for again. */
  stale(): void;
  /** Called whenever a late answer arrives, so what is on screen can be drawn again. */
  subscribe(listener: () => void): void;
}

/**
 * Opens a cache over one session's completions, kept between keystrokes and refreshed behind them.
 *
 * ```ts
 * import { completionCache } from './completion.ts';
 *
 * import type { ReplSession } from '../../repl/session.ts';
 *
 * // Defined, not invoked: it asks a live page.
 * function example(session: ReplSession) {
 *   return completionCache(session).lookup(''); // what is known right now, never a wait
 * }
 * ```
 */
export function completionCache(session: ReplSession): CompletionCache {
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
      .completions(base)
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
 * import { complete } from './completion.ts';
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
  names: CompletionCache,
  line: string,
  callback: CompleterCallback,
  cwd: string = process.cwd(),
): void {
  // A path line completes like a shell, because that is what is being typed on it.
  const typedPath = pathBeingTyped(line);
  if (typedPath !== null) return callback(null, [pathsContinuing(typedPath, cwd), typedPath]);

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
 * import { setupSuggestionBehaviors } from './completion.ts';
 *
 * import type { REPLServer } from 'node:repl';
 *
 * // Defined, not invoked: it listens on a live terminal.
 * function example(server: REPLServer) {
 *   setupSuggestionBehaviors(server); // ghost text on, Ctrl-F accepts
 * }
 * ```
 */
export function setupSuggestionBehaviors(
  server: REPLServer,
  names?: CompletionCache,
  cwd: string = process.cwd(),
): () => string {
  const style = mutedSuggestionStyle();
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

    return fits(line, offered(line));
  };

  const offered = (line: string): string => {
    // `history` is readline's own record, newest first, and absent from `@types/node`'s REPLServer
    // — reached through a narrow cast rather than by widening the whole server.
    const history = (server as unknown as { history?: string[] }).history ?? [];
    // A path line is answered from the filesystem — the only place that knows — and never from
    // history, where `.cat` lines are as likely to be about a file that has since been renamed.
    // Asked once. This used to call `pathSuggestion` — which parses the line — and then parse it
    // AGAIN to find out whether the empty answer meant "no suggestion" or "not a path line".
    if (pathBeingTyped(line) !== null) return pathSuggestion(line, cwd);

    const position = split(line);

    return suggestFromNames(line, {
      names: position && names ? names.lookup(position.base) : [],
      history,
    });
  };

  /**
   * The suggestion, or nothing at all where the line and it together would not sit on the row.
   *
   * A suggestion is what you are about to type. Something that cannot be shown on the line cannot
   * be that — it wraps across rows and takes the prompt apart, which is the whole reason a REPL
   * has a prompt on one row. What it measures is the WHOLE entry, since what is typed plus what is
   * left of it is exactly that, however much of it has been typed.
   *
   * Which is also what makes a history entry that two writes glued together harmless: three
   * hundred characters have never fitted on a row, so they are never offered. Recalling something
   * that long is what the up arrow is for.
   */
  const fits = (line: string, ghost: string): string => {
    const columns = (server.output as NodeJS.WriteStream).columns ?? 0;
    const used = plainLength(server.getPrompt()) + line.length + ghost.length;

    return columns > 0 && used >= columns ? '' : ghost;
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
 * The terminal escape sequence the GHOST SUGGESTION is drawn in — grey, so it reads as something
 * offered rather than something typed.
 *
 * Not a theme capture and not `red()`: this is one colour, for one piece of text, and the only
 * question about it is how dim "dim" should be on the terminal you are actually using. Which is
 * why it is read from the environment.
 *
 * Read from the environment rather than guessed at, because "muted" against a light terminal and
 * against a dark one are different colours and only the developer knows which they are on.
 * `QUNITX_SUGGEST_STYLE` is the direct spelling; `ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE` is honoured when
 * it has been exported, since somebody running zsh has already answered this question once.
 *
 * ```ts
 * import { mutedSuggestionStyle } from './completion.ts';
 *
 * mutedSuggestionStyle().startsWith(String.fromCharCode(27)); // true — an SGR sequence either way
 * ```
 */
export function mutedSuggestionStyle(): string {
  const configured =
    process.env.QUNITX_SUGGEST_STYLE ?? process.env.ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE;
  const colour = configured?.match(/fg=#?([0-9a-fA-F]{6}|\d{1,3})/)?.[1];
  if (!colour) return `${ESCAPE}[90m`;

  // `fg=8` is a palette index, `fg=#585858` is a truecolour triple — zsh writes both.
  if (/^\d{1,3}$/.test(colour)) return `${ESCAPE}[38;5;${colour}m`;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(colour.slice(at, at + 2), 16));

  return `${ESCAPE}[38;2;${r};${g};${b}m`;
}

// ── Completing a path rather than a name ──────────────────────────────────────
//
// The other half of what TAB and the ghost answer, and the half the page knows nothing about: a
// `.cat` line is completed from the FILESYSTEM. Here rather than in lib/repl/, because which
// commands take a path is a fact about this prompt's commands and nothing else.

/** The commands that take a path, and so complete like a shell rather than like an expression. */
const PATH_COMMANDS = /^\s*\.(?:cat|view|tree|ls|import|load)\s+(?:.*\s)?(\S*)$/;

/**
 * The path being typed on a `.cat` or `.view` line, or `null` on any other line.
 *
 * What decides whether a completion is a filename or an expression — and `null` is the signal to
 * go and ask the page instead. A path with a space in it is not completable here, which is the
 * same bargain a dot command already makes with its argument.
 *
 * ```ts
 * import { pathBeingTyped } from './completion.ts';
 *
 * pathBeingTyped('.cat lib/re'); // 'lib/re'
 * pathBeingTyped('.view '); // '' — everything in the working directory
 * pathBeingTyped('document.ti'); // null — an expression, not a path
 * ```
 */
export function pathBeingTyped(line: string): string | null {
  const typed = PATH_COMMANDS.exec(line)?.[1];
  if (typed === undefined) return null;
  // `-L` takes a number, and a number is not a path. Completing one would offer files for it.
  if (typed.startsWith('-') || /(?:^|\s)-L\s*$/.test(line.slice(0, line.length - typed.length))) {
    return null;
  }

  return typed;
}

/**
 * Every path that continues `typed`, spelled the way it was — directories with a trailing slash.
 *
 * Hidden entries only once a dot has been typed, which is the rule every shell uses and the reason
 * `.cat ` does not open with a list of dotfiles. That rule is about what was TYPED, so it is
 * decided once rather than re-asked for every entry in the directory.
 *
 * One pass. This used to filter twice and then map, walking the entries three times and allocating
 * an array each time; the listing it does first costs five times all of that put together, so the
 * saving is small — but the two-filter shape was also hiding the loop-invariant above.
 *
 * ```ts
 * import { pathsContinuing } from './completion.ts';
 *
 * pathsContinuing('lib/re', process.cwd()); // ['lib/repl/'] — a directory, and it says so
 * pathsContinuing('nowhere/at/all', process.cwd()); // [] — an unreadable directory offers nothing
 * ```
 */
export function pathsContinuing(typed: string, cwd: string): string[] {
  const slash = typed.lastIndexOf('/');
  // Kept verbatim rather than rebuilt, so `./lib/` and `lib/` each come back the way they went in.
  const prefix = typed.slice(0, slash + 1);
  const partial = typed.slice(slash + 1);
  const directory = path.resolve(cwd, prefix || '.');

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const dotWasTyped = partial.startsWith('.');
  const continuing: string[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(partial)) continue;
    if (!dotWasTyped && entry.name.startsWith('.')) continue;
    continuing.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
  }

  return continuing.sort();
}

/**
 * What to draw after the cursor on a path line: the rest of the shortest path that continues it.
 *
 * `pathSuggestion` and not `suggest`, because `suggest` is what this file already imports for the
 * OTHER kind of suggestion — the one made from names the page has and from history. Two `suggest`s
 * in one function, one of them namespaced, is what this used to read as.
 *
 * Empty for a line that is not a path line, so a caller can fall through to that other one.
 * Shortest for the same reason a name is: `lib/` is what `li` meant far more often than the
 * longest thing underneath it.
 *
 * ```ts
 * import { pathSuggestion } from './completion.ts';
 *
 * pathSuggestion('document.ti', process.cwd()); // '' — not a path line, so not this one's answer
 * ```
 */
export function pathSuggestion(line: string, cwd: string): string {
  const typed = pathBeingTyped(line);
  if (typed === null || typed === '') return '';

  let best = '';
  for (const candidate of pathsContinuing(typed, cwd)) {
    if (candidate.length <= typed.length) continue;
    if (best === '' || candidate.length < best.length) best = candidate;
  }

  return best === '' ? '' : best.slice(typed.length);
}
