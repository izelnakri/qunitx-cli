import process from 'node:process';
import { ESCAPE, plainLength } from '../../repl/columns.ts';
import * as Files from '../../repl/files.ts';
import { split, suggest } from '../../repl/suggest.ts';
import type { REPLServer } from 'node:repl';
import type { ReplSession } from '../../repl/session.ts';

/** What `node:repl` hands a completer to answer through: the matches, and the word they finish. */
/** Ctrl-F, the key that takes the suggestion. */
const CTRL_F = '\u0006';

export type CompleterCallback = (error: null, result: [string[], string]) => void;

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

export function completionCache(session: ReplSession): NameSource {
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
 * import { setupSuggestions } from './completion.ts';
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

    return fits(line, offered(line));
  };

  const offered = (line: string): string => {
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
 * The escape sequence a suggestion is drawn in, muted the way zsh mutes its own.
 *
 * Read from the environment rather than guessed at, because "muted" against a light terminal and
 * against a dark one are different colours and only the developer knows which they are on.
 * `QUNITX_SUGGEST_STYLE` is the direct spelling; `ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE` is honoured when
 * it has been exported, since somebody running zsh has already answered this question once.
 *
 * ```ts
 * import { suggestionStyle } from './completion.ts';
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
