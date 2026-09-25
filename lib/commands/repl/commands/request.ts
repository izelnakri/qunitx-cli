import {
  printBody,
  printRequest,
  printRequestLine,
  printHeaders,
  printStatus,
} from '../print-request.ts';
import { pickRequest, parseRequestKind } from '../../../repl/http-service.ts';
import { red } from '../../../utils/color.ts';
import type { RequestReference, HttpRequest } from '../../../repl/http-service.ts';
import type { ReplCommand, ReplContext } from '../command.ts';

/**
 * `.request` — what a request actually was, after the fact.
 *
 * A verb command prints the answer once, in the shape that suits reading it. This is the other
 * half: the session kept every request it made, and this is how you go back and ask one of them a
 * narrower question than "what happened".
 *
 * The shapes:
 *
 * ```
 * .request                            everything about the last request
 * .request list                       every request this session has made, one line each
 * .request 2                          the one before it — counting back, the way the list reads
 * .request #7                         the request called #7, whatever has happened since
 * .request /api/users                 everything about the last one to that URL
 * .request post:/api/users            …and only the POSTs to it
 * .request /api/users headers sent    just the headers, just that request
 * .request /api/users headers.sent    the same, said as a field rather than an argument
 * .request /api/users headers.etag    just one of them — `headers[etag]` too
 * .request /api/users headers received
 * .request /api/users body            the whole body, however long
 * .request /api/users status          the status line on its own
 * .request body                       the last request's body, no URL needed
 * ```
 *
 * The URL is matched forgivingly — the resolved URL if that is what was typed, otherwise anything
 * containing it — so `.request users` finds `http://localhost:4321/api/users?page=2` without
 * anybody pasting a query string back in.
 *
 * ```ts
 * import { command as requestCommand } from './request.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return requestCommand.main(repl, '/api/users body'); // that request's body, in full
 * }
 * ```
 */
export const command: ReplCommand = {
  description:
    'Details of a request already made — `.request 2`, `.request #7`, `.request users body`',
  aliases: ['req'],
  main(repl, argument) {
    const asked = argument.trim();
    if (asked.toLowerCase() === 'list') return void list(repl);

    const { kind, target, name } = parseRequestPart(asked);
    const requestKind = parseRequestKind(target);
    const request = pickRequest(repl.http, requestKind, repl.session.url);
    if (request === null) return void printRequestReferenceNotFound(repl, requestKind);

    show(repl, request, kind, name);
  },
};

/** Which part of a request was asked for. `whole` is what a bare `.request` means. */
type RequestPart = 'whole' | 'headers-sent' | 'headers-received' | 'body' | 'status';

/**
 * The part a trailing word or two names, and whatever came before it.
 *
 * Read from the END because the URL comes first and may be anything, including a word this would
 * otherwise recognise: `.request /body body` is the body of the request to `/body`, and there is
 * no ambiguity as long as the part is the last thing said.
 *
 * ```ts
 * import { parseRequestPart } from './request.ts';
 *
 * parseRequestPart('/api/users headers sent'); // { kind: 'headers-sent', target: '/api/users' }
 * parseRequestPart('body'); // { kind: 'body', target: '' } — the last request's
 * parseRequestPart('/api/users'); // { kind: 'whole', target: '/api/users' }
 * ```
 */
export function parseRequestPart(asked: string): {
  kind: RequestPart;
  target: string;
  name?: string;
} {
  const words = asked.split(/\s+/).filter((word) => word !== '');
  const lastPart = words.at(-1)?.toLowerCase();
  const secondLastPart = words.at(-2)?.toLowerCase();
  const named = getHeaderName(secondLastPart ?? '');

  // `headers.sent` is the same request as `headers sent`: a dot is how a field is read in the
  // language this prompt speaks, and a space is how an argument is written — both come out, so
  // both work. Checked before a named header, so the two side words are never read as names.
  const dotted = getHeaderType(lastPart ?? '');
  if (dotted !== null) {
    return { kind: `headers-${dotted}`, target: words.slice(0, -1).join(' ') };
  }
  if (
    (isHeadersWord(secondLastPart ?? '') || named !== null) &&
    (lastPart === 'sent' || lastPart === 'received')
  ) {
    return {
      kind: `headers-${lastPart}`,
      target: words.slice(0, -2).join(' '),
      ...(named === null ? {} : { name: named }),
    };
  }
  // `headers` alone means the ones that came BACK, which is what somebody looking at a response
  // means by the word nine times out of ten. One header by name means the same side.
  const lastNamed = getHeaderName(lastPart ?? '');
  if (lastNamed !== null) {
    return { kind: 'headers-received', target: words.slice(0, -1).join(' '), name: lastNamed };
  }
  if (isHeadersWord(lastPart ?? ''))
    return { kind: 'headers-received', target: words.slice(0, -1).join(' ') };
  if (lastPart === 'body' || lastPart === 'status') {
    return { kind: lastPart, target: words.slice(0, -1).join(' ') };
  }

  return { kind: 'whole', target: words.join(' ') };
}

/**
 * The side a `headers.sent` or `header['received']` names, or `null` where it names neither.
 *
 * The two words that are not header names, in the spelling that reads them as fields. A header
 * literally called `sent` is therefore unaskable by that route — and nobody has one, while
 * everybody types this.
 *
 * ```ts
 * import { getHeaderType } from './request.ts';
 *
 * getHeaderType('headers.sent'); // 'sent'
 * getHeaderType('.header.received'); // 'received' — the leading dot of the command name is forgiven
 * getHeaderType('headers.etag'); // null — a name, which is a different question
 * ```
 */
export function getHeaderType(word: string): 'sent' | 'received' | null {
  const said = /^\.?headers?(?:\.|\[\s*['"]?)(sent|received)['"]?\s*\]?$/.exec(word.toLowerCase());

  return said ? (said[1] as 'sent' | 'received') : null;
}

/** `headers`, `header`, and either with the leading dot of the command it is named after. */
function isHeadersWord(word: string): boolean {
  return /^\.?headers?$/.test(word);
}

/**
 * The one header a `headers.etag` or `headers[etag]` asks for, or `null` where that is not what
 * was said.
 *
 * Both spellings, because both hands type both: a dot is how you read a field off a thing in the
 * language this prompt speaks, and brackets are how you read one whose name has a dash in it —
 * which, for HTTP headers, is most of them. Quotes inside the brackets are allowed and ignored,
 * since `headers['content-type']` is what somebody with JavaScript in their fingers writes.
 *
 * ```ts
 * import { getHeaderName } from './request.ts';
 *
 * getHeaderName('headers.etag'); // 'etag'
 * getHeaderName('header.etag'); // 'etag' — singular too, since one is what was asked for
 * getHeaderName('headers[content-type]'); // 'content-type'
 * getHeaderName("headers['content-type']"); // 'content-type'
 * getHeaderName('headers'); // null — all of them, which is a different question
 * ```
 */
export function getHeaderName(word: string): string | null {
  // A leading dot is forgiven — `.headers.etag` is the command's own name typed twice, which is
  // what fingers do. `header` and `headers` both, because one header is what you are asking for
  // and both words come out: the plural reads as the block it is indexing, the singular as the
  // thing it returns.
  if (getHeaderType(word) !== null) return null;

  const dotted = /^\.?headers?\.([^\s.[\]]+)$/.exec(word);
  if (dotted) return dotted[1]!.toLowerCase();

  const bracketed = /^\.?headers?\[\s*['"]?([^\]'"]+)['"]?\s*\]$/.exec(word);

  return bracketed ? bracketed[1]!.trim().toLowerCase() : null;
}

/** One connection, in whichever shape was asked for. */
function show(repl: ReplContext, connection: HttpRequest, kind: RequestPart, name?: string): void {
  const dim = repl.palette.painter('LineNr');
  if (kind === 'whole') return void repl.log(printRequest(connection, repl.palette));
  if (kind === 'status') return void repl.log(printStatus(connection, repl.palette));
  // One header, from whichever side was named. A miss says which side it looked at, because
  // "there is no etag" and "you asked the wrong half" are different answers.
  if (name !== undefined) {
    const side = kind === 'headers-sent' ? 'sent' : 'received';
    const headers = side === 'sent' ? connection.request.headers : connection.response?.headers;
    const value = headers?.get(name);

    return void repl.log(
      value === undefined
        ? dim(
            `no ${name} ${side} — \`.request ${side === 'sent' ? 'headers sent' : 'headers'}\` for the ones there are`,
          )
        : printHeaders(new Map([[name, value]]), repl.palette),
    );
  }
  if (kind === 'headers-sent') {
    repl.log(printHeaders(connection.request.headers, repl.palette));
    repl.log(
      dim('— the runtime adds host, content-length, accept-encoding and its own sec-fetch-*'),
    );

    return;
  }
  if (connection.response === null) {
    repl.log(red(`nothing came back — ${connection.failed ?? 'the request failed'}`));

    return;
  }
  if (kind === 'headers-received') {
    return void repl.log(printHeaders(connection.response.headers, repl.palette));
  }
  // The whole body, however long: a narrower question deserves the complete answer, and this is
  // the only spelling that gives one.
  repl.log(printBody(connection.response, repl.palette, Infinity));
}

/**
 * Every request this session has made, newest FIRST.
 *
 * The one you just made is the one you are looking for, and a prompt scrolls away from you: the
 * bottom of a list printed oldest-first is where the answer is, which is the one place a terminal
 * puts next to the line you are typing on and then pushes off the top. This way the list also
 * counts the way {@link countingBack} does — the first line is `.request 1`.
 */
function list(repl: ReplContext): void {
  const dim = repl.palette.painter('LineNr');
  if (repl.http.requests.length === 0) {
    repl.log(dim('No requests yet — `.get /` makes one'));

    return;
  }
  const now = Date.now();

  repl.write(
    `${repl.http.requests
      .map((connection) => printRequestLine(connection, repl.palette, now))
      .reverse()
      .join('\n')}\n`,
  );
}

/**
 * Said in terms of HOW it was looked for: an id, a position and a URL each miss differently.
 *
 * Exported for `.header`, which takes the same two ways of naming a request and should fail in
 * the same words — a session that says "No request #9" under one command and something else under
 * the other is teaching two vocabularies for one thing.
 *
 * ```ts
 * import { printRequestReferenceNotFound } from './request.ts';
 *
 * import type { ReplContext } from '../command.ts';
 *
 * // Defined, not invoked: it writes to a live prompt.
 * function example(repl: ReplContext) {
 *   return printRequestReferenceNotFound(repl, { kind: 'id', id: 9 }); // 'No request #9 — `.request list` …'
 * }
 * ```
 */
export function printRequestReferenceNotFound(
  repl: ReplContext,
  reference: RequestReference,
): void {
  const dim = repl.palette.painter('LineNr');
  const made = repl.http.requests.length;
  if (made === 0) {
    repl.log(dim('No requests yet — `.get /` makes one'));

    return;
  }
  // Three ways of asking, and each miss is a different mistake: an id that was never handed out
  // (or has aged out of the list), a position past the end, and a URL nothing matched.
  if (reference.kind === 'id') {
    repl.log(dim(`No request #${reference.id} — \`.request list\` for the ones there are`));
  } else if (reference.kind === 'position') {
    repl.log(dim(`Only ${made} request${made === 1 ? '' : 's'} so far — \`.request list\``));
  } else {
    repl.log(dim(`No request to ${reference.url} — \`.request list\` for the ones there are`));
  }
}
