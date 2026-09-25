// The HTTP client behind `.get`, `.header` and `.request`. Engine, not terminal: no `node:repl`,
// no colours, no writing anywhere. It answers questions about requests; drawing them is
// `lib/commands/repl/print-request.ts`, and typing them is `lib/commands/repl/commands/*`.
//
// The requests are made from NODE, not from the page, and that is a decision rather than an
// accident. A `fetch` inside the tab cannot tell you what it sent — the browser appends
// `sec-fetch-*`, rewrites `user-agent`, and forbids you from setting `host` or reading
// `set-cookie` back off a cross-origin response. `.header sent` and `.header received` would
// both be lies. From here the request is exactly what was typed, nothing is hidden by CORS, and
// a session can talk to an API that has never heard of the page.

/** What was actually handed to `fetch` — the request, as this session made it. */
export interface Request {
  /** Upper case, the way HTTP writes it and every log prints it. */
  verb: string;
  /** Absolute, already resolved against the page. */
  url: string;
  /** Lower-cased names, because HTTP says they are the same header either way. */
  headers: ReadonlyMap<string, string>;
  /** `null` for the verbs that carry nothing, which is not the same as an empty body. */
  body: string | null;
}

/** What came back. Absent on an {@link HttpRequest} that never got a reply. */
export interface Response {
  /** The code, which is an answer even when it is a 404. */
  status: number;
  /** `''` where the protocol does not carry one — HTTP/2 never does. */
  statusText: string;
  /** Lower-cased names, as they came off the wire. */
  headers: ReadonlyMap<string, string>;
  /** Decoded text, or `''` where the body was not text. */
  body: string;
  /** The size on the wire, which is the honest number even where the body was not kept. */
  bytes: number;
  /** True where the body was longer than the cap and the rest was dropped, unread. */
  bodyTruncated: boolean;
  /** True where the content type is not something a terminal should be asked to print. */
  binary: boolean;
}

/** One request and whatever became of it. */
export interface HttpRequest {
  /**
   * What this request is called for the rest of the session: `#3`, and `.request #3` afterwards.
   *
   * Counts up and never repeats, so a number keeps meaning the same request however many more are
   * made — which a position counted from the end cannot. `0` until a store has kept it:
   * {@link remember} is what names one.
   */
  id: number;
  /** The request, exactly as it was made. */
  request: Request;
  /** `null` where it failed before a reply — DNS, connection refused, timeout. */
  response: Response | null;
  /** Why there is no reply, said the way it would be said out loud. `null` where there is one. */
  failed: string | null;
  /** Wall-clock milliseconds, rounded — a REPL has no use for the fractions. */
  ms: number;
  /** When it was made, for ordering and for saying how long ago. */
  at: number;
}

/**
 * A session's HTTP state: the headers it will send next, and everything it has sent.
 *
 * Mutable on purpose, and for the same reason {@link ReplContext.scratch} is — `.header accept=x`
 * and the `.get` three lines later are different commands, and the whole point is that the second
 * one remembers the first.
 */
export interface HttpService {
  /** Saved for every upcoming request, lower-cased. `.header list` prints this. */
  headers: Map<string, string>;
  /** Oldest first, newest last, capped at {@link REQUESTS_KEPT}. */
  requests: HttpRequest[];
  /**
   * The body buffer `.post … :` opens: one for the life of the session, so reopening it continues
   * the same thought rather than starting a blank one — the request equivalent of the scratchpad
   * a prompt keeps. Saved empty is how it is cleared.
   */
  scratchpadText: string;
  /**
   * The last id handed out. Kept here rather than counted from `requests.length`, which stops
   * being the number of requests made the moment the cap drops the oldest one — and an id that
   * starts repeating is worse than no id at all.
   */
  lastId: number;
}

/**
 * How many requests a session keeps.
 *
 * A REPL that is left open all afternoon against a polling endpoint should not be the reason the
 * process runs out of memory, and nobody has ever gone looking for their two-hundredth-oldest
 * request. The bodies are what make this worth capping at all.
 *
 * ```ts
 * import { REQUESTS_KEPT } from './http-service.ts';
 *
 * REQUESTS_KEPT > 0; // true
 * ```
 */
export const REQUESTS_KEPT = 200;

/** How much of a body is kept. Beyond this the read is cancelled rather than merely dropped. */
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/** How long a request is given before it is abandoned. Long enough for a slow API, not forever. */
const TIMEOUT_MS = 30_000;

/** The verbs that get their own command, and the ones `.request post:/x` will accept as a prefix. */
const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** What this client calls itself, since something has to and a blank one gets filtered. */

/**
 * An empty store — one per session.
 *
 * ```ts
 * import { create } from './http-service.ts';
 *
 * create().requests.length; // 0
 * ```
 */
export function create(): HttpService {
  return { headers: new Map(DEFAULT_HEADERS), requests: [], scratchpadText: '', lastId: 0 };
}

/**
 * What a session sends before you have said anything about headers.
 *
 * A browser's own two: the user-agent a Chrome on this platform would send, and JSON for the
 * accept — which is what a prompt pointed at an API wants nine times out of ten, and the thing
 * people forget to set before wondering why they got HTML back. They are SAVED rather than
 * applied at send time, so `.header list` shows them, `.header delete accept` drops one, and
 * nothing is sent that you cannot see.
 *
 * The version here goes stale; the session replaces it with the page's own `navigator.userAgent`
 * on start-up, which is the same string with the real numbers in it.
 *
 * ```ts
 * import { DEFAULT_HEADERS } from './http-service.ts';
 *
 * DEFAULT_HEADERS.get('accept'); // 'application/json'
 * DEFAULT_HEADERS.get('user-agent')?.includes('Chrome'); // true
 * ```
 */
export const DEFAULT_HEADERS: ReadonlyMap<string, string> = new Map([
  [
    'user-agent',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/153.0.0.0 Safari/537.36',
  ],
  ['accept', 'application/json'],
]);

/**
 * A header as it was typed, or `null` where that is not a header at all.
 *
 * Both spellings, because both hands type both: `accept=application/json` is what you write when
 * you are assigning something, and `accept: application/json` is what you get when you copy a line
 * out of a response. Whichever separator comes FIRST is the separator, which is what makes
 * `content-type: text/html; charset=utf-8` land the way it reads rather than splitting on the
 * `charset=`.
 *
 * The name is lower-cased because HTTP does not distinguish, and a session that thought
 * `Accept` and `accept` were two headers would send both.
 *
 * ```ts
 * import { parseHeader } from './http-service.ts';
 *
 * parseHeader('Accept=application/json'); // { name: 'accept', value: 'application/json' }
 * parseHeader('content-type: text/html; charset=utf-8')?.value; // 'text/html; charset=utf-8'
 * parseHeader('accept'); // null — nothing assigned
 * parseHeader('bad header=x'); // null — a space is not allowed in a header name
 * ```
 */
export function parseHeader(text: string): { name: string; value: string } | null {
  const trimmed = text.trim();
  const colon = trimmed.indexOf(':');
  const equals = trimmed.indexOf('=');
  const at = smallestAbove(-1, colon, equals);
  if (at <= 0) return null;

  const name = trimmed.slice(0, at).trim().toLowerCase();
  if (!isValidHeaderName(name)) return null;

  return { name, value: trimmed.slice(at + 1).trim() };
}

/**
 * Whether a name is one HTTP will carry — the token characters RFC 9110 allows, and no others.
 *
 * Checked here rather than left to `fetch`, which throws a `TypeError` naming neither the header
 * nor what was wrong with it.
 *
 * ```ts
 * import { isValidHeaderName } from './http-service.ts';
 *
 * isValidHeaderName('x-request-id'); // true
 * isValidHeaderName('x request id'); // false
 * ```
 */
export function isValidHeaderName(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

/**
 * A `[verb:]url` argument, split.
 *
 * `post:/api/users` is a POST to `/api/users`; `/api/users` is whichever verb the caller means by
 * no verb at all. Only the five verbs that have commands count as a prefix, which is what keeps
 * `http://x` and `localhost:3000/x` from being read as one — neither `http` nor `localhost` is a
 * verb.
 *
 * ```ts
 * import { parseRequestInputTarget } from './http-service.ts';
 *
 * parseRequestInputTarget('post:/api/users'); // { verb: 'POST', url: '/api/users' }
 * parseRequestInputTarget('localhost:3000/x'); // { verb: null, url: 'localhost:3000/x' }
 * parseRequestInputTarget('https://x/y'); // { verb: null, url: 'https://x/y' }
 * ```
 */
export function parseRequestInputTarget(text: string): { verb: string | null; url: string } {
  const trimmed = text.trim();
  const at = trimmed.indexOf(':');
  if (at <= 0) return { verb: null, url: trimmed };

  const head = trimmed.slice(0, at).toLowerCase();
  if (!(HTTP_VERBS as readonly string[]).includes(head)) return { verb: null, url: trimmed };

  return { verb: head.toUpperCase(), url: trimmed.slice(at + 1).trim() };
}

/**
 * The absolute URL a target means, or `null` where it means nothing usable.
 *
 * One rule, and it is the one a test runner's REPL wants: anything without a scheme is the PAGE's
 * own server. `.get /tests.js` is the file the suite loaded, `.get api/users` is that route on the
 * same origin, and anywhere else on the internet is spelled with an `http://` in front of it.
 *
 * The exceptions are the ones nobody would accept being read as a path: an explicit scheme, a
 * protocol-relative `//host/x`, a host with a port on it — `localhost:3000/x` and `127.0.0.1:8080`
 * are addresses in every tool that takes one, and reading them as filenames would be perverse —
 * and a bare `:3000/x`, which is that same address with the part you never vary left out.
 *
 * A bare `example.com/x` IS read as a path, deliberately: `tests.js` and `fixtures/page.html` are
 * far commoner things to type at this prompt than a naked domain, and there is no way to tell the
 * two apart without guessing at TLDs. Writing the scheme settles it, and the commands say so.
 *
 * ```ts
 * import { resolveUserInputURL } from './http-service.ts';
 *
 * const page = 'http://localhost:4321/index.html';
 * resolveUserInputURL('/tests.js', page); // 'http://localhost:4321/tests.js'
 * resolveUserInputURL('api/users', page); // 'http://localhost:4321/api/users'
 * resolveUserInputURL('localhost:3000/x', page); // 'http://localhost:3000/x'
 * resolveUserInputURL(':3000/x', page); // 'http://localhost:3000/x' — the port on this machine
 * resolveUserInputURL('https://example.com', page); // 'https://example.com/'
 * resolveUserInputURL('/tests.js', null); // null — nothing to be relative to
 * ```
 */
export function resolveUserInputURL(target: string, pageUrl: string | null): string | null {
  const trimmed = target.trim();
  if (trimmed === '') return null;

  // Addresses BEFORE schemes, because `localhost:3000/x` satisfies both readings and only one of
  // them is right: `scheme:` and `host:port` are the same shape, and `new URL` believes the first
  // one it is offered — `localhost:` as a protocol, with `3000/x` for a path.
  // `:4000/api/users` is the port on this machine — what everybody types when the other terminal
  // is the one serving it. Nothing else can be meant: a path never starts with a colon.
  const addressed = /^:\d+(?=[/?#]|$)/.test(trimmed) ? `localhost${trimmed}` : trimmed;
  const absolute =
    addressed.startsWith('//') || looksLikeHost(addressed)
      ? `http://${addressed.replace(/^\/\//, '')}`
      : hasScheme(addressed)
        ? addressed
        : null;

  try {
    // `new URL(relative, base)` is the resolution every browser uses, which is the one anybody
    // typing a path at a REPL pointed at a page already has in their head.
    return new URL(absolute ?? addressed, absolute === null ? (pageUrl ?? undefined) : undefined)
      .href;
  } catch {
    return null;
  }
}

/**
 * `url`, with `params` folded into its query: `{ page: 2 }` on `/api/users` is `/api/users?page=2`.
 *
 * What a GET's argument means. A GET carries no body — `fetch` throws a bare `TypeError` if you
 * try — so an object after the URL can only be one thing, and writing it as an object is how
 * somebody at a JavaScript prompt says a query without hand-encoding it.
 *
 * A name already in the URL is replaced rather than repeated, because the object is the later and
 * more specific statement. An array repeats the name, which is what every server that takes a list
 * expects; anything deeper is JSON, which is what the ones that take a structure expect. A value
 * that is `null` or `undefined` is not a parameter at all: a value you do not have is not one you
 * meant to send.
 *
 * ```ts
 * import { setQueryParams } from './http-service.ts';
 *
 * setQueryParams('http://x/api/users', { page: 2 }); // 'http://x/api/users?page=2'
 * setQueryParams('http://x/a?page=1', { page: 2, tag: ['new', 'old'] });
 * // 'http://x/a?page=2&tag=new&tag=old'
 * setQueryParams('http://x/a', { missing: undefined }); // 'http://x/a'
 * ```
 */
export function setQueryParams(url: string, params: Readonly<Record<string, unknown>>): string {
  const parsed = new URL(url);
  const said = (one: unknown) => (typeof one === 'object' ? JSON.stringify(one) : String(one));
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    // `set` first, `append` after: set replaces a name that was already there WHERE it was, so a
    // query keeps the order it was written in rather than being reshuffled by what overrode it.
    parsed.searchParams.set(name, said(values[0]));
    for (const one of values.slice(1)) parsed.searchParams.append(name, said(one));
  }

  return parsed.href;
}

/**
 * Sends one request and records everything about it, including the ways it can go wrong.
 *
 * Nothing here throws. A REPL command that throws is a stack trace where a sentence belongs, and
 * every failure this can meet — refused, unresolved, timed out, aborted — is an answer worth
 * printing rather than an exception worth raising.
 *
 * The body is read through the stream rather than with `.text()` so that {@link BODY_LIMIT_BYTES}
 * can be enforced BEFORE the bytes are in memory: a REPL pointed at an endless stream should stop
 * reading it, not fill the heap and then apologise. A body that is not text is counted and not
 * decoded, because the one thing worse than a huge response is a terminal full of PNG.
 *
 * ```ts
 * import { request } from './http-service.ts';
 *
 * // Defined, not invoked: it opens a socket.
 * function example() {
 *   return request({ verb: 'GET', url: 'http://localhost:1/x', headers: new Map() });
 * }
 * ```
 */
export async function request(asked: {
  verb: string;
  url: string;
  headers: ReadonlyMap<string, string>;
  body?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<HttpRequest> {
  const headers = buildHeadersWithDefaults(asked.headers, asked.body ?? null);
  const outgoing: Request = {
    verb: asked.verb.toUpperCase(),
    url: asked.url,
    headers,
    body: asked.body ?? null,
  };
  const started = performance.now();
  const at = Date.now();

  try {
    const answered = await fetch(asked.url, {
      method: outgoing.verb,
      headers: [...headers],
      body: outgoing.body,
      redirect: 'follow',
      signal: AbortSignal.timeout(asked.timeoutMs ?? TIMEOUT_MS),
    });
    const response = await readBody(answered, asked.maxBytes ?? BODY_LIMIT_BYTES);

    // `id: 0` — nothing has kept this yet, and a request that is never kept never gets a name.
    return {
      id: 0,
      request: outgoing,
      response,
      failed: null,
      ms: Math.round(performance.now() - started),
      at,
    };
  } catch (error) {
    return {
      id: 0,
      request: outgoing,
      response: null,
      failed: getFailureMessage(error, asked.timeoutMs ?? TIMEOUT_MS),
      ms: Math.round(performance.now() - started),
      at,
    };
  }
}

/**
 * Files a request, newest last, naming it as it goes and dropping the oldest once there are
 * {@link REQUESTS_KEPT} of them.
 *
 * ```ts
 * import { create, store } from './http-service.ts';
 *
 * const httpService = create();
 * store(httpService, { id: 0, request: { verb: 'GET', url: 'http://x/', headers: new Map(),
 *   body: null }, response: null, failed: 'refused', ms: 1, at: 0 });
 * httpService.requests.length; // 1
 * ```
 */
export function store(httpService: HttpService, request: HttpRequest): void {
  request.id = ++httpService.lastId;
  httpService.requests.push(request);
  if (httpService.requests.length > REQUESTS_KEPT) {
    httpService.requests.splice(0, httpService.requests.length - REQUESTS_KEPT);
  }
}

/**
 * Replaces the default user-agent with the page's own, which is the one a server should see.
 *
 * The constant in {@link DEFAULT_HEADERS} goes stale the moment Chrome ships a version; the page
 * in front of this session knows the real one. `Headless` comes out of it because a server that
 * behaves differently for a robot would behave differently for a prompt, and the prompt is a
 * person — the rest of the string is left exactly as the browser wrote it.
 *
 * Only ever replaces the default: a session that has already said `.header user-agent=…` means it.
 *
 * ```ts
 * import { setUserAgent, create } from './http-service.ts';
 *
 * const httpService = create();
 * await setUserAgent(httpService, { toJSON: () => Promise.resolve('"Mozilla/5.0 (Chrome)"') });
 * httpService.headers.get('user-agent'); // 'Mozilla/5.0 (Chrome)'
 * ```
 */
export async function setUserAgent(
  httpService: HttpService,
  session: { toJSON(expression: string): Promise<string | null> },
): Promise<void> {
  if (httpService.headers.get('user-agent') !== DEFAULT_HEADERS.get('user-agent')) return;

  const answered = await session
    .toJSON("navigator.userAgent.replace('Headless', '')")
    .catch(() => null);
  const agent = answered === null ? null : (JSON.parse(answered) as unknown);
  if (typeof agent === 'string' && agent !== '') httpService.headers.set('user-agent', agent);
}

/**
 * Which request an argument names: a name (`#3`), a position counted back (`2`), or a URL.
 *
 * The `#` is what tells the first two apart, and they answer different questions: a position
 * moves as you work — `2` is the one before last, whichever that is now — while an id is the name
 * a request keeps for the session. Everything else is a URL, matched the forgiving way.
 *
 * ```ts
 * import { parseRequestKind } from './http-service.ts';
 *
 * parseRequestKind('#3'); // { kind: 'id', id: 3 }
 * parseRequestKind('2'); // { kind: 'position', back: 2 }
 * parseRequestKind('post:/api/users'); // { kind: 'url', verb: 'POST', url: '/api/users' }
 * ```
 */
export function parseRequestKind(target: string): RequestReference {
  const trimmed = target.trim();
  if (/^#\d+$/.test(trimmed) && Number(trimmed.slice(1)) > 0) {
    return { kind: 'id', id: Number(trimmed.slice(1)) };
  }
  if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) {
    return { kind: 'position', back: Number(trimmed) };
  }

  return { kind: 'url', ...parseRequestInputTarget(trimmed) };
}

/**
 * How a request was asked for — what {@link parseRequestKind} read, and what a miss has to explain.
 *
 * ```ts
 * import type { RequestReference } from './http-service.ts';
 *
 * const asked: RequestReference = { kind: 'id', id: 3 };
 * asked.kind; // 'id'
 * ```
 */
export type RequestReference =
  | { kind: 'id'; id: number }
  | { kind: 'position'; back: number }
  | { kind: 'url'; verb: string | null; url: string };

/**
 * The request a {@link RequestReference} picks out, or `null` where the session made no such one.
 *
 * ```ts
 * import { create, pickRequest, parseRequestKind } from './http-service.ts';
 *
 * pickRequest(create(), parseRequestKind('#1'), null); // null — nothing has been sent
 * ```
 */
export function pickRequest(
  httpService: HttpService,
  asked: RequestReference,
  pageUrl: string | null,
): HttpRequest | null {
  if (asked.kind === 'id') {
    return httpService.requests.find((request) => request.id === asked.id) ?? null;
  }
  if (asked.kind === 'position') return httpService.requests.at(-asked.back) ?? null;

  return peekRequest(httpService, asked.verb, asked.url, pageUrl);
}

/**
 * The most recent request a `[verb:]url` means, or `null` where the session never made one.
 *
 * Newest first, because "the request to /api/users" means the last one when a session has made
 * six. An empty `url` means the last request of all, which is what a bare `.request` asks for.
 *
 * Matching is exact-then-forgiving: the fully resolved URL if that is what was typed, otherwise
 * any request whose URL CONTAINS the text. `.request /api/users` should find
 * `http://localhost:4321/api/users?page=2` without anybody having to paste the query string back
 * in, and `.request users` should find it too.
 *
 * ```ts
 * import { peekRequest, create } from './http-service.ts';
 *
 * peekRequest(create(), null, ''); // null — nothing has been sent
 * ```
 */
export function peekRequest(
  httpService: HttpService,
  verb: string | null,
  url: string,
  pageUrl: string | null = null,
): HttpRequest | null {
  const wanted = url.trim();
  const resolved = wanted === '' ? null : resolveUserInputURL(wanted, pageUrl);

  for (let at = httpService.requests.length - 1; at >= 0; at--) {
    const request = httpService.requests[at] as HttpRequest;
    if (verb !== null && request.request.verb !== verb) continue;
    if (wanted === '') return request;
    if (request.request.url === resolved || request.request.url.includes(wanted)) return request;
  }

  return null;
}

/**
 * A byte count as a person would read it: `0 bytes`, `812 bytes`, `4.2 KB`, `1.3 MB`.
 *
 * Whole numbers under a kilobyte because nobody wants `0.8 KB`, one decimal above it because the
 * difference between 4.2 and 4.9 is the difference between two answers.
 *
 * ```ts
 * import { formatBytes } from './http-service.ts';
 *
 * formatBytes(1); // '1 byte'
 * formatBytes(812); // '812 bytes'
 * formatBytes(4_300); // '4.2 KB'
 * ```
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? '' : 's'}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Whether a content type is something a terminal should be asked to print.
 *
 * Text, JSON, XML, and the `+json`/`+xml` suffixes every API invents — everything else is bytes,
 * and bytes in a terminal is a beep and a broken prompt.
 *
 * ```ts
 * import { isTextual } from './http-service.ts';
 *
 * isTextual('application/json; charset=utf-8'); // true
 * isTextual('application/vnd.api+json'); // true
 * isTextual('image/png'); // false
 * isTextual(''); // true — nothing said, so assume it can be read
 * ```
 */
export function isTextual(contentType: string): boolean {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === '') return true;

  return (
    type.startsWith('text/') ||
    type.endsWith('+json') ||
    type.endsWith('+xml') ||
    TEXTUAL_TYPES.has(type)
  );
}

/** The content types that are text without saying `text/`, which is most of the interesting ones. */
const TEXTUAL_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/ld+json',
  'application/javascript',
  'application/ecmascript',
  'application/xml',
  'application/xhtml+xml',
  'application/x-www-form-urlencoded',
  'application/graphql',
  'image/svg+xml',
]);

/**
 * The headers actually handed to `fetch`: what was saved, plus the two every client sets and the
 * one a body implies.
 *
 * Defaults rather than overrides — a session that has said `.header accept=application/json` means
 * it, and a client that quietly replaced it would be the bug this whole feature exists to expose.
 *
 * `content-type` is guessed from the body's first character, which is the same guess `curl -d` and
 * every HTTP client makes: a body starting `{` or `[` is JSON far more often than it is anything
 * else, and saying otherwise is one `.header content-type=…` away.
 */
function buildHeadersWithDefaults(
  saved: ReadonlyMap<string, string>,
  body: string | null,
): Map<string, string> {
  const headers = new Map(saved);
  if (!headers.has('accept')) headers.set('accept', '*/*');
  // From {@link DEFAULT_HEADERS} rather than a second constant: a session seeds its store with
  // these, and a `send` that bypasses a store should not claim to be something else.
  if (!headers.has('user-agent')) {
    headers.set('user-agent', DEFAULT_HEADERS.get('user-agent') as string);
  }
  if (body !== null && !headers.has('content-type')) {
    const first = body.trimStart()[0];

    headers.set('content-type', first === '{' || first === '[' ? 'application/json' : 'text/plain');
  }

  return headers;
}

/**
 * Reads a response, stopping at the cap rather than after it.
 *
 * The reader is CANCELLED at the limit, which is what closes the socket on a server that would
 * happily keep sending — dropping the chunks after reading them would cap the memory and none of
 * the waiting.
 */
async function readBody(answered: globalThis.Response, maxBytes: number): Promise<Response> {
  const headers = new Map<string, string>();
  for (const [name, value] of answered.headers) headers.set(name.toLowerCase(), value);

  const binary = !isTextual(headers.get('content-type') ?? '');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let bodyTruncated = false;

  const reader = answered.body?.getReader();
  if (reader !== undefined) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      bytes += value.byteLength;
      if (bytes > maxBytes) {
        bodyTruncated = true;
        if (!binary) chunks.push(value.subarray(0, value.byteLength - (bytes - maxBytes)));
        await reader.cancel();
        break;
      }
      if (!binary) chunks.push(value);
    }
  }

  return {
    status: answered.status,
    statusText: answered.statusText,
    headers,
    body: binary ? '' : new TextDecoder().decode(concatBodyChunks(chunks)),
    bytes,
    bodyTruncated,
    binary,
  };
}

/** One buffer out of many, because `TextDecoder` should see the whole thing or split a code point. */
function concatBodyChunks(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;

  const whole = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }

  return whole;
}

/**
 * A `fetch` failure in a sentence.
 *
 * `fetch` says `TypeError: fetch failed` and hides what happened in `cause`, so every one of these
 * reads identically until it is unwrapped — and "fetch failed" is the least useful thing a prompt
 * could say about a refused connection.
 */
function getFailureMessage(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `no answer within ${Math.round(timeoutMs / 1000)}s`;
  }
  const cause = (error as { cause?: unknown })?.cause;
  // A host that resolves to both address families is reported as an AggregateError over both
  // attempts, and the aggregate's own message is empty — the code is on the errors inside it.
  const attempts = (cause as { errors?: unknown[] })?.errors;
  const inner = Array.isArray(attempts) ? (attempts[0] ?? cause) : cause;
  const code = (inner as { code?: string })?.code;
  if (code !== undefined) return REFUSALS[code] ?? code;

  const said = ((inner as Error)?.message ?? (error as Error)?.message ?? String(error)).trim();

  return said === '' ? 'the request failed' : said;
}

/** The handful of socket errors worth saying in words, since their codes are not words. */
const REFUSALS: Readonly<Record<string, string>> = {
  ECONNREFUSED: 'connection refused',
  ENOTFOUND: 'no such host',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ETIMEDOUT: 'connection timed out',
  CERT_HAS_EXPIRED: 'the certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'a self-signed certificate',
};

/** Whether a target names its own protocol, in which case nothing is resolved against anything. */
function hasScheme(target: string): boolean {
  return /^[a-z][a-z0-9+\-.]*:/i.test(target);
}

/**
 * Whether a schemeless target is an address rather than a path.
 *
 * Only the unmistakable ones: `localhost`, an IPv4, or any host carrying an explicit port. A bare
 * domain is left to be a path, because `tests.js` is a likelier thing to type here than `bbc.co.uk`
 * and no rule tells the two apart without a list of every TLD.
 */
function looksLikeHost(target: string): boolean {
  const host = target.split(/[/?#]/)[0] ?? '';

  return (
    /^localhost(:\d+)?$/i.test(host) ||
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host) ||
    /^\[[0-9a-f:]+\](:\d+)?$/i.test(host) ||
    /^[a-z0-9-]+(\.[a-z0-9-]+)*:\d+$/i.test(host)
  );
}

/** The smallest of the candidates that is above `floor`, or `floor` where none of them is. */
function smallestAbove(floor: number, ...candidates: readonly number[]): number {
  const above = candidates.filter((at) => at > floor);

  return above.length === 0 ? floor : Math.min(...above);
}
