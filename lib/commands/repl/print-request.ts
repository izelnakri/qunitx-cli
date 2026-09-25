import {
  blue,
  green,
  magenta,
  onBlue,
  onGreen,
  onRed,
  onYellow,
  red,
  yellow,
} from '../../utils/color.ts';
import { formatBytes } from '../../repl/http-service.ts';
import { highlight } from '../../repl/highlight.ts';
import type { HttpRequest, Response } from '../../repl/http-service.ts';
import type { Theme } from '../../repl/theme.ts';

// Printing an HTTP request for a terminal, the way `drawTree` draws a directory: data in, string
// out. Three commands print these — `.get` and its four siblings, `.header received|sent`, and
// `.request` — and they print the SAME blocks, which is the whole reason this is one module and
// not three near-copies.

/**
 * How much of a body a request command prints before it starts saying "there is more".
 *
 * ```ts
 * import { MAX_BODY_PREVIEW_LINES_COUNT } from './print-request.ts';
 *
 * MAX_BODY_PREVIEW_LINES_COUNT > 0; // true
 * ```
 */
export const MAX_BODY_PREVIEW_LINES_COUNT = 40;

/** And the character budget, for the body that is one enormous line — a minified bundle. */
const MAX_BODY_PREVIEW_CHARS_COUNT = 4_000;

/**
 * What a request was for: `GET http://localhost:4321/api/users`.
 *
 * One phrase in one colour, because you typed it — it is there to identify an answer, not to be
 * read again. That is also why it no longer gets a line of its own: {@link printStatus} carries it
 * after what came back, where it costs nothing and still says which request this is.
 *
 * ```ts
 * import { printTarget } from './print-request.ts';
 *
 * printTarget({ verb: 'GET', url: 'http://x/y', headers: new Map(), body: null });
 * // 'GET http://x/y'
 * ```
 */
export function printTarget(request: HttpRequest['request']): string {
  return `${paintVerb(request.verb)} ${blue(request.url)}`;
}

/**
 * The whole answer in one line:
 * `200 OK · 101 bytes · 9ms | GET http://localhost:4000/api/users | #3`.
 *
 * The status wears its class as a ground rather than as text, because it is the one thing on the
 * line that is looked for before the line is read. Green for the 2xx, yellow for a redirect, blue
 * for the 4xx — information, not breakage; a 404 is often the answer you went looking for — and
 * red for the 5xx and for a request that never got an answer at all.
 *
 * The size and the time are painted on the same three-tone scale as everything else here (see
 * {@link sizeTone} and {@link durationTone}), so a slow or enormous reply says so before you have
 * read the number. Then the target, after a dim bar: the request this was, in one info colour.
 * Then its id, dim, in the spelling that asks for it again — `.request #3`.
 *
 * ```ts
 * import { printStatus } from './print-request.ts';
 *
 * const plain = { painter: () => (text: string) => text };
 * const at = { status: 200, statusText: 'OK', headers: new Map(), body: '{}', bytes: 2,
 *   bodyTruncated: false, binary: false };
 * printStatus({ id: 3, request: { verb: 'GET', url: 'http://x/', headers: new Map(), body: null },
 *   response: at, failed: null, ms: 23, at: 0 }, plain).endsWith('| GET http://x/ | #3'); // true
 * ```
 */
export function printStatus(connection: HttpRequest, palette: Theme): string {
  // The id last and dim, exactly as the list writes it: what is on screen is what you type back
  // (`.request #3`), so it carries no label — a label would be a word to translate rather than a
  // word to copy. `0` is an connection nothing has kept, which has no name to give.
  const named =
    connection.id > 0 ? ` ${bar(palette)} ${palette.painter('LineNr')(`#${connection.id}`)}` : '';
  const target = `${bar(palette)} ${printTarget(connection.request)}${named}`;
  if (connection.response === null) {
    return `${onRed(connection.failed ?? 'no answer')} ${dot(palette)} ${paintTime(connection.ms)} ${target}`;
  }
  const { status, statusText, bytes, bodyTruncated, binary } = connection.response;
  const said = statusText === '' ? String(status) : `${status} ${statusText}`;
  const size = `${formatBytes(bytes)}${bodyTruncated ? '+' : ''}`;
  const kind = binary ? ` ${palette.painter('LineNr')(contentType(connection.response))}` : '';

  return (
    `${badge(statusTone(status))(said)} ${dot(palette)} ` +
    `${paint(sizeTone(bytes))(size)}${kind} ${dot(palette)} ${paintTime(connection.ms)} ${target}`
  );
}

/**
 * What a number or a status is worth saying about: the vocabulary every colour here is chosen from.
 *
 * ```ts
 * import type { Tone } from './print-request.ts';
 *
 * const tone: Tone = 'good';
 * tone; // 'good'
 * ```
 */
export type Tone = 'good' | 'warn' | 'info' | 'bad';

/**
 * Which tone a status wears — the one place the four classes are decided.
 *
 * ```ts
 * import { statusTone } from './print-request.ts';
 *
 * statusTone(204); // 'good'
 * statusTone(301); // 'warn'
 * statusTone(404); // 'info' — an answer, not a breakage
 * statusTone(500); // 'bad'
 * ```
 */
export function statusTone(status: number): Tone {
  if (status < 300) return 'good';
  else if (status < 400) return 'warn';
  else if (status < 500) return 'info';

  return 'bad';
}

/**
 * Which tone a body size wears. A terminal stops being comfortable around a hundred kilobytes and
 * stops coping around a megabyte, so those are the two boundaries.
 *
 * ```ts
 * import { sizeTone } from './print-request.ts';
 *
 * sizeTone(101); // 'good'
 * sizeTone(200_000); // 'warn'
 * sizeTone(4_000_000); // 'bad'
 * ```
 */
export function sizeTone(bytes: number): Tone {
  if (bytes < 100_000) return 'good';
  else if (bytes < 1_000_000) return 'warn';

  return 'bad';
}

/**
 * Which tone a round trip wears. A tenth of a second is where a person starts to notice waiting,
 * and a second is where they start doing something else.
 *
 * ```ts
 * import { durationTone } from './print-request.ts';
 *
 * durationTone(9); // 'good'
 * durationTone(300); // 'warn'
 * durationTone(4_000); // 'bad'
 * ```
 */
export function durationTone(milliseconds: number): Tone {
  if (milliseconds < 100) return 'good';
  else if (milliseconds < 1_000) return 'warn';

  return 'bad';
}

/**
 * A block of headers, one per line, with the names in the colour that means "this is what you
 * came to find".
 *
 * Sorted, because a header block is looked THROUGH rather than read, and the order a server
 * happened to send them in helps nobody find `content-type`.
 *
 * ```ts
 * import { printHeaders } from './print-request.ts';
 *
 * const plain = { painter: () => (text: string) => text };
 * printHeaders(new Map([['b', '2'], ['a', '1']]), plain); // 'a: 1\nb: 2' — painted where colour is on
 * printHeaders(new Map(), plain); // '' — nothing to print, and the caller says so in words
 * ```
 */
export function printHeaders(headers: ReadonlyMap<string, string>, _palette: Theme): string {
  // The name in the info colour rather than dimmed: a header block is looked THROUGH for a name,
  // so the names are the part that is read — and it is the same colour a URL wears, which is the
  // other thing in this client you look for before you read around it.
  return [...headers]
    .sort(([one], [other]) => one.localeCompare(other))
    .map(([name, value]) => `${blue(`${name}:`)} ${value}`)
    .join('\n');
}

/**
 * The body, as much of it as was asked for.
 *
 * JSON is re-indented before it is printed — an API that answers in one 8KB line is answering a
 * machine, and this is not one. It is then run through the same highlighter the prompt uses,
 * because JSON is JavaScript's own notation and the colours already mean the right things.
 *
 * A body that is not text is never printed, only described. A terminal handed a PNG beeps, loses
 * its cursor, and sometimes changes its own character set.
 *
 * `limit` of `Infinity` is the whole thing, which is what `.request … body` asks for.
 *
 * ```ts
 * import { printBody } from './print-request.ts';
 *
 * const plain = { painter: () => (text: string) => text };
 * const json = { status: 200, statusText: 'OK', headers: new Map([['content-type',
 *   'application/json']]), body: '{"a":1}', bytes: 7, bodyTruncated: false, binary: false };
 * printBody(json, plain, Infinity); // '{\n  "a": 1\n}'
 * ```
 */
export function printBody(received: Response, palette: Theme, limit: number): string {
  if (received.binary) {
    return palette.painter('LineNr')(
      `<${formatBytes(received.bytes)} of ${contentType(received)}, not shown>`,
    );
  }
  if (received.body === '') return palette.painter('LineNr')('<empty>');

  const text = reindented(received.body, contentType(received));
  const painted = isCodeLike(contentType(received)) ? highlight(text, palette) : text;
  const shortened = limit === Infinity ? null : shorten(painted, limit);
  const more = shortened === null ? '' : `\n${palette.painter('LineNr')(shortened.note)}`;
  const cut =
    received.bodyTruncated && limit === Infinity
      ? `\n${palette.painter('LineNr')(`<stopped at ${formatBytes(received.bytes)}>`)}`
      : '';

  return `${shortened?.text ?? painted}${more}${cut}`;
}

/**
 * Everything about one connection: what was sent, what came back, and the body.
 *
 * What `.request` prints with nothing narrowing it — the `-v` of this client, and the reason the
 * narrower spellings exist at all.
 *
 * ```ts
 * import { printRequest } from './print-request.ts';
 *
 * const plain = { painter: () => (text: string) => text };
 * const request = { verb: 'GET', url: 'http://x/y', headers: new Map(), body: null };
 * printRequest({ id: 1, request, response: null, failed: 'connection refused', ms: 2, at: 0 }, plain)
 *   .includes('connection refused'); // true
 * ```
 */
export function printRequest(connection: HttpRequest, palette: Theme): string {
  // What was sent, then what came back, in that order and with nothing labelling them: a blank
  // line between blocks already says "this is a different thing", and four dim captions over four
  // blocks that are each unmistakable is the kind of help that costs a screenful.
  //
  // The sent headers sit UNDER the status line with no gap, because they are that request — the
  // gap starts where the answer does.
  const asked =
    connection.request.headers.size > 0 ? printHeaders(connection.request.headers, palette) : '';
  const blocks = [[printStatus(connection, palette), asked].filter(Boolean).join('\n')];

  if (connection.request.body !== null && connection.request.body !== '')
    blocks.push(connection.request.body);
  if (connection.response !== null) {
    if (connection.response.headers.size > 0) {
      blocks.push(printHeaders(connection.response.headers, palette));
    }
    blocks.push(printBody(connection.response, palette, MAX_BODY_PREVIEW_LINES_COUNT));
  }

  return blocks.join('\n\n');
}

/**
 * One connection on one line, for a list of them: `2m ago  #3   200  GET     /api/users`.
 *
 * The status wears its ground the way it does everywhere else, the verb its own colour, and the
 * age is yellow while it is still recent — which is what a log is scanned for.
 *
 * Age rather than a clock time, because "did I send that before or after I changed the header" is
 * the question a request log is read to answer, and a wall-clock timestamp makes you do the
 * subtraction yourself.
 *
 * ```ts
 * import { printRequestLine } from './print-request.ts';
 *
 * const plain = { painter: () => (text: string) => text };
 * const request = { verb: 'GET', url: 'http://x/y', headers: new Map(), body: null };
 * const line = printRequestLine({ id: 1, request, response: null, failed: 'refused', ms: 1,
 *   at: Date.now() }, plain, Date.now());
 * line.includes('GET'); // true
 * ```
 */
export function printRequestLine(connection: HttpRequest, palette: Theme, now: number): string {
  const since = now - connection.at;
  // Recent is yellow, older is dim: "did I send that before or after I changed the header" is the
  // question a log is read to answer, and the answer is nearly always in the last minute or two.
  const ago = (since < RECENTLY_MS ? yellow : palette.painter('LineNr'))(
    agoInWords(since).padStart(7),
  );
  const status =
    connection.response === null
      ? onRed('---')
      : badge(statusTone(connection.response.status))(String(connection.response.status));
  // The id and the URL are both dim, for opposite reasons: an id is how you SAY a request
  // (`.request #3`) rather than something you read the list for, and a URL repeated down every
  // line is the part a scan skips over. What is left bright is what tells the lines apart.
  const dim = palette.painter('LineNr');
  const id = dim(`#${connection.id}`.padEnd(4));

  return `${ago} ${id} ${status} ${paintVerb(connection.request.verb.padEnd(6))} ${dim(connection.request.url)}`;
}

/** How recent counts as recent, in the one place a list and a person have to agree about it. */
const RECENTLY_MS = 2 * 60 * 1000;

/**
 * How long ago, in the shortest true words: `just now`, `12s ago`, `4m ago`, `2h ago`.
 *
 * ```ts
 * import { agoInWords } from './print-request.ts';
 *
 * agoInWords(500); // 'just now'
 * agoInWords(12_000); // '12s ago'
 * agoInWords(240_000); // '4m ago'
 * ```
 */
export function agoInWords(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;

  return `${Math.round(seconds / 3600)}h ago`;
}

/** The content type with its parameters dropped — `application/json`, never `; charset=utf-8`. */
function contentType(received: Response): string {
  const whole = received.headers.get('content-type') ?? '';

  return whole.split(';')[0]?.trim() || 'an unnamed type';
}

/** A tone as text colour — for a number, or for a status in a list where a badge would be a wall. */
function paint(tone: Tone): (text: string) => string {
  return { good: green, warn: yellow, info: blue, bad: red }[tone];
}

/**
 * The colour a verb wears, wherever a verb is printed — the reading ones cool, the writing ones
 * warm, and the one that destroys something red. The same five every HTTP tool has taught.
 *
 * ```ts
 * import { paintVerb } from './print-request.ts';
 *
 * paintVerb('GET'); // 'GET', blue when the terminal takes colour
 * ```
 */
export function paintVerb(verb: string): string {
  const paintIt =
    { GET: blue, POST: green, PUT: magenta, PATCH: yellow, DELETE: red }[verb.trim()] ?? blue;

  return paintIt(verb);
}

/** A tone as a ground, for the one thing on the line that should be found before it is read. */
function badge(tone: Tone): (text: string) => string {
  return { good: onGreen, warn: onYellow, info: onBlue, bad: onRed }[tone];
}

/** The round trip, on the same scale as everything else — the one caller that never has a size. */
function paintTime(milliseconds: number): string {
  return paint(durationTone(milliseconds))(`${milliseconds}ms`);
}

/** The separator between the parts of a status line — dim, so the parts are what is read. */
function dot(palette: Theme): string {
  return palette.painter('LineNr')('·');
}

/** And the heavier one, between what came back and what was asked for. */
function bar(palette: Theme): string {
  return palette.painter('LineNr')('|');
}

/** Whether the highlighter has anything useful to say about this type. JSON is JavaScript's own. */
function isCodeLike(type: string): boolean {
  return type.endsWith('json') || type.includes('javascript') || type.includes('ecmascript');
}

/**
 * JSON, re-indented. Anything else, and anything that will not parse, exactly as it arrived.
 *
 * Wrapped in a `try` rather than tested first: the test for "is this JSON" is parsing it, and a
 * body that claims to be JSON and is not is a thing servers do.
 */
function reindented(body: string, type: string): string {
  if (!type.endsWith('json')) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/**
 * The first `lines` lines, or the first {@link MAX_BODY_PREVIEW_CHARS_COUNT} characters, whichever comes
 * first — and a note naming what would show the rest.
 *
 * `null` where the whole thing already fits, so a caller can tell "shortened" from "short".
 */
function shorten(text: string, lines: number): { text: string; note: string } | null {
  const rows = text.split('\n');
  const tooTall = rows.length > lines;
  const kept = tooTall ? rows.slice(0, lines).join('\n') : text;
  const tooWide = kept.length > MAX_BODY_PREVIEW_CHARS_COUNT;
  if (!tooTall && !tooWide) return null;

  const shown = tooWide ? kept.slice(0, MAX_BODY_PREVIEW_CHARS_COUNT) : kept;
  const remaining = tooTall && !tooWide ? `${rows.length - lines} more lines` : 'the rest';

  return { text: shown, note: `— ${remaining}, \`.request body\` for all of it` };
}
