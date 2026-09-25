/** Where a breakpoint goes, in whatever coordinates the realm running the code uses. */
export interface BreakpointTarget {
  /** What the realm calls the script: a bundle's URL, or the file's own. */
  url: string;
  /** Zero-based, because that is what CDP takes. */
  lineNumber: number;
  /** Zero-based too, and 0 wherever nothing narrower is known. */
  columnNumber: number;
  /** One-based, and what the prompt echoes back — the line in the file the person named. */
  sourceLine: number;
}

/**
 * The V8 a prompt is talking to.
 *
 * {@link ReplSession} is written almost entirely in CDP — `Runtime.evaluate`, `Debugger.paused`,
 * `Runtime.getProperties` — and a browser page is only one thing that speaks it. Node and Deno
 * speak the same protocol over `--inspect`, minus the domains that need a document. So this is the
 * shape of what a prompt actually needs: enough to run an expression, stop on a line, and read a
 * stopped scope. Nothing here assumes a DOM, and nothing here is a Playwright type — which is the
 * whole point, since a `page.reload()` and a re-spawned process are the same idea told twice.
 *
 * One implementation per runtime: `lib/repl/page-realm.ts` drives a Playwright page, and
 * `lib/repl/inspector-realm.ts` drives a `node --inspect` / `deno run --inspect` child.
 *
 * The protocol is typed the way `session.ts` already types it: each caller names the slice of the
 * answer it reads, beside the question. Playwright's generated map would have given that for free,
 * but `playwright-core` does not export `./types/protocol` — the deep path resolves under one of
 * this repo's two type-checkers and not the other, which is a worse bargain than saying what we
 * read. It also keeps the seam free of playwright entirely, which is the point of having one.
 *
 * A node inspector answers a subset of the protocol; asking it for `Page.enable` is a runtime
 * refusal rather than a type error, which is the honest shape given both runtimes answer most of
 * what a prompt asks.
 */
export interface Realm {
  /** One CDP call. Every question a session asks of a running V8 goes through here. */
  send<T = void>(method: string, params?: Record<string, unknown>): Promise<T>;
  /**
   * One CDP event.
   *
   * Subscribed BEFORE the domains are enabled, deliberately: enabling `Debugger` replays every
   * script already parsed, and a listener added afterwards misses the bundle it most wants.
   */
  on(event: string, handler: (params: never) => void): void;
  /**
   * Whether a file on disk can be loaded as ITSELF here, rather than bundled into the realm first.
   *
   * False for a page, which can only be given code through a document and therefore only ever
   * runs a bundle. True for a runtime, and worth the branch: a file imported as itself keeps its
   * own identity in V8, so a breakpoint set on it is a breakpoint the import actually hits.
   */
  readonly importsFromDisk: boolean;
  /**
   * Where a `file:line` somebody typed lives in THIS realm, or why it cannot be found.
   *
   * The two answers are genuinely different questions. A page runs a BUNDLE, so the line has to
   * be looked up in a source map and the breakpoint set on the bundle's URL. A runtime runs the
   * file, so the line IS the line and the URL is the file — no map, and nothing to be missing.
   */
  breakpointAt(absolute: string, line: number): BreakpointTarget | string;
  /** Whether there is still something on the other end to ask. */
  alive(): boolean;
  /** The same code again with an empty scope — a page reload, or a runtime restarted. */
  reload(): Promise<void>;
  /**
   * Whether DevTools could be offered at all — asked once, at start-up, for the banner.
   *
   * Separate from {@link Realm.devtoolsURL} and deliberately cheap: the address is worth making
   * only when somebody asks for it, and this is the question the banner has.
   */
  inspectable(): Promise<boolean>;
  /**
   * Chrome's own DevTools, attached to THIS realm, as a URL a person can open.
   *
   * `null` where there is no way to serve one — which is a real answer rather than a failure: an
   * address pointing at somebody else's realm would be worse than no address at all.
   */
  devtoolsURL(): Promise<string | null>;
  /**
   * Let go of the transport, and nothing else.
   *
   * Separate from {@link Realm.closing} and awaited before it, because a detach whose target is
   * already going away never settles — it costs the full cleanup grace on every exit.
   */
  detach(): Promise<void>;
  /**
   * The handles this realm owns, named, for one `closeCompletely` alongside the session's own.
   *
   * A record rather than a `close()` so that a cleanup that times out can still say WHICH handle
   * it was still waiting on.
   */
  closing(): Readonly<Record<string, Promise<unknown>>>;
}
