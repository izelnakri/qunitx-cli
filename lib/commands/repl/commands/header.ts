import { printHeaders } from '../print-request.ts';
import {
  isValidHeaderName,
  parseHeader,
  pickRequest,
  parseRequestKind,
} from '../../../repl/http-service.ts';
import { red } from '../../../utils/color.ts';
import { printRequestReferenceNotFound } from './request.ts';
import type { ReplCommand, ReplContext } from '../command.ts';

/**
 * `.header` — what this session will send, and what the last request actually sent and got back.
 *
 * Three questions that are really one, which is why they are one command. "What am I sending",
 * "what did I send", and "what came back" are asked in the same breath, and a prompt that made you
 * remember three names for them would be answering a different question than the one you have.
 *
 * The shapes:
 *
 * ```
 * .header                        what all of this is — the shapes below, on one screen
 * .header list                   the headers saved for the next request
 * .header accept=application/json   save one — `.header accept: application/json` also works
 * .header add accept=…           the same, for hands that want a verb
 * .header accept                 what one is set to
 * .header delete accept [more…]  stop sending them — `del`, `remove` and `rm` too
 * .header clear                  stop sending any of them
 * .header sent                   what the last request actually sent
 * .header received               what came back on the last request
 * .header 2 sent                 the same, for an earlier request — `#3` names one by id
 * .header received #3            either order: which half and which request, in either sequence
 * ```
 *
 * `.headers` is the same command, with one difference: bare, the plural lists. The plural IS the
 * block, so asking for it by itself means "show me them"; the singular reads as a question about
 * the command, and answers with what it can do. Everything after the name behaves identically.
 *
 * ```ts
 * import { command as headerCommand } from './header.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return headerCommand.main(repl, 'accept=application/json'); // saved for the next request
 * }
 * ```
 */
export const command: ReplCommand = {
  description: 'Headers to send, and the ones sent and received last — `.header accept=text/html`',
  main(repl, argument) {
    const input = argument.trim();
    // Bare, it says what it can do. Listing the saved headers on no argument was the older
    // behaviour and the commoner mistake: `.header` reads like a question about the command.
    if (input === '') return void printHeadersCommandHelp(repl);

    // Before the subcommands, so that a header genuinely called `list` or `sent` can still be set:
    // an assignment is unmistakable, and a bare word is not.
    const assignment = parseHeader(input);
    if (assignment !== null) return void saveHeader(repl, assignment.name, assignment.value);

    const [firstArgument = '', ...rest] = input.split(/\s+/);
    switch (firstArgument.toLowerCase()) {
      case 'list':
        return void printExistingHeaders(repl);
      case 'add':
        return void saveHeaderAssignment(repl, rest.join(' '));
      case 'delete':
      case 'del':
      case 'remove':
      case 'rm':
        return void removeHeaders(repl, rest);
      case 'clear':
        return void clearHeaders(repl);
      // `sent`/`received` first and the request after it — `.header received #3` — because both
      // orders get typed: one reads as "which half", the other as "of which request". Neither is
      // the wrong one, and a target that was ignored is how `.header received #4` used to answer
      // with a request that was not #4 at all.
      case 'sent':
      case 'received':
        return void printHeadersOfARequest(
          repl,
          firstArgument.toLowerCase() as 'sent' | 'received',
          rest[0],
        );
      default:
        // `2` and `#3` say WHICH request, the same way `.request` takes them — so a header block
        // can be asked for without switching commands, and the side still follows it.
        return void (hasRequestReference(firstArgument)
          ? printHeadersOfARequest(
              repl,
              rest[0]?.toLowerCase() === 'received' ? 'received' : 'sent',
              firstArgument,
            )
          : printHeaderValue(repl, input));
    }
  },
};

/**
 * `.headers` — the same command, answering the plural's question when nothing follows it.
 *
 * ```ts
 * import { plural } from './header.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return plural.main(repl, ''); // the saved headers, where `.header` would print its shapes
 * }
 * ```
 */
export const plural: ReplCommand = {
  description: 'The headers saved for the next request — everything `.header` does, by its plural',
  main: (repl, argument) => command.main(repl, argument.trim() === '' ? 'list' : argument),
};

/** Whether a word names a request rather than a header — `2`, `#3`; a header name has letters. */
function hasRequestReference(firstArgument: string): boolean {
  return /^#?\d+$/.test(firstArgument);
}

/** The shapes, on one screen: what a bare `.header` is asking about. */
function printHeadersCommandHelp(repl: ReplContext): void {
  const dim = repl.palette.painter('LineNr');
  const line = (shape: string, says: string) => `${shape.padEnd(30)}${dim(says)}`;

  repl.log(
    [
      line('.header list', 'the headers saved for the next request'),
      line('.header accept=text/html', 'save one — `.header add accept=…` too'),
      line('.header accept', 'what one is set to'),
      line('.header delete accept', 'stop sending it — `del`, `remove`, `rm`'),
      line('.header clear', 'stop sending any of them'),
      line('.header sent | received', 'what the last request sent, or got back'),
      line('.header 2 | #3 [received]', 'the same, for an earlier request'),
      line('.header received #3', 'either order — which half, which request'),
      line('.headers', 'the plural, bare, is the list'),
    ].join('\n'),
  );
}

/**
 * One side of one connection's headers: the last request's, or an earlier one's.
 *
 * `requestReference` is how that earlier one was named — a position or an id — and `undefined` is
 * the last, which is what `.header sent` on its own means. One function rather than three, because
 * which connection to read is the only thing that differed between them.
 */
function printHeadersOfARequest(
  repl: ReplContext,
  side: 'sent' | 'received',
  requestReference: string | undefined,
): void {
  const dim = repl.palette.painter('LineNr');
  const connectionReference =
    requestReference === undefined ? null : parseRequestKind(requestReference);
  const connection =
    connectionReference === null
      ? (repl.http.requests.at(-1) ?? null)
      : pickRequest(repl.http, connectionReference, repl.session.url);

  if (connection === null) {
    if (connectionReference !== null)
      return void printRequestReferenceNotFound(repl, connectionReference);

    return void repl.log(dim('No requests yet — `.get /` makes one'));
  }
  if (side === 'sent') {
    repl.log(printHeaders(connection.request.headers, repl.palette));

    return void repl.log(
      dim('— the runtime adds host, content-length, accept-encoding and its own sec-fetch-*'),
    );
  }
  if (connection.response === null) {
    return void repl.log(red(`nothing came back — ${connection.failed ?? 'the request failed'}`));
  }
  repl.log(printHeaders(connection.response.headers, repl.palette));
}

/** The headers saved for the next request, or the sentence that says there are none. */
function printExistingHeaders(repl: ReplContext): void {
  if (repl.http.headers.size === 0) {
    const dim = repl.palette.painter('LineNr');

    repl.log(
      dim('No headers saved — `.header accept=application/json` saves one for every request'),
    );

    return;
  }
  repl.log(printHeaders(repl.http.headers, repl.palette));
}

/** `.header add key=value`, which is `.header key=value` for anybody who wanted to say the verb. */
function saveHeaderAssignment(repl: ReplContext, input: string): void {
  const assignment = parseHeader(input);
  if (assignment === null) {
    repl.log(red('Usage: .header add <name>=<value> — `.header add accept=application/json`'));

    return;
  }
  saveHeader(repl, assignment.name, assignment.value);
}

/**
 * Saves one, and says what it saved.
 *
 * Echoed rather than answered with silence: a header you believe you set and did not is a
 * debugging session about the wrong thing, and the echo is how a typo in the VALUE is caught too.
 */
function saveHeader(repl: ReplContext, name: string, value: string): void {
  repl.http.headers.set(name, value);
  repl.log(printHeaders(new Map([[name, value]]), repl.palette));
}

/** `.header delete accept x-token` — any number of them, and it says which were not there. */
function removeHeaders(repl: ReplContext, names: readonly string[]): void {
  if (names.length === 0) {
    repl.log(red('Usage: .header delete <name> [name…] — `.header clear` for all of them'));

    return;
  }
  const dim = repl.palette.painter('LineNr');
  const gone: string[] = [];
  const missing: string[] = [];
  for (const input of names) {
    const name = input.toLowerCase();
    if (!isValidHeaderName(name)) missing.push(input);
    else if (repl.http.headers.delete(name)) gone.push(name);
    else missing.push(name);
  }

  if (gone.length > 0) repl.log(dim(`no longer sending ${gone.join(', ')}`));
  if (missing.length > 0) repl.log(dim(`was not sending ${missing.join(', ')}`));
}

/** `.header clear`, which says how many it dropped so that an empty session reads as one. */
function clearHeaders(repl: ReplContext): void {
  const had = repl.http.headers.size;
  repl.http.headers.clear();

  repl.log(repl.palette.painter('LineNr')(had === 0 ? 'nothing was saved' : `cleared ${had}`));
}

/** `.header accept` — what one is set to, which is the question a bare name asks. */
function printHeaderValue(repl: ReplContext, input: string): void {
  const name = input.toLowerCase();
  if (!isValidHeaderName(name)) {
    repl.log(red(`${input} is not a header name — try \`.header\` for what is saved`));

    return;
  }
  const value = repl.http.headers.get(name);
  if (value === undefined) {
    repl.log(repl.palette.painter('LineNr')(`${name} is not set`));

    return;
  }
  repl.log(printHeaders(new Map([[name, value]]), repl.palette));
}
