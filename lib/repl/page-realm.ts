import { prelaunchPromise, shutdownPrelaunch } from '../chrome/prelaunch.ts';
import { proxyTo } from './proxy.ts';
import type { Proxy } from './proxy.ts';
import type { Browser as PlaywrightBrowser, CDPSession, Page } from 'playwright-core';
import type { Realm } from './realm.ts';

/**
 * A {@link Realm} that is a browser page — what `qunitx repl` has always talked to.
 *
 * Everything here was the session's until the prompt learned to talk to a runtime as well. It is
 * the half that could not move: a page-scoped Playwright CDP session, a reload that is a
 * navigation, and a DevTools address that only exists where Chrome was pre-launched with an HTTP
 * endpoint to serve one from.
 *
 * ```ts
 * import { pageRealm } from './page-realm.ts';
 *
 * import type { Browser, CDPSession, Page } from 'playwright-core';
 *
 * // Defined, not invoked: it takes live handles.
 * function example(cdp: CDPSession, page: Page, browser: Browser) {
 *   return pageRealm({ cdp, page, browser }).send('Runtime.enable');
 * }
 * ```
 */
export function pageRealm(handles: {
  cdp: CDPSession;
  page: Page;
  browser: PlaywrightBrowser;
}): Realm {
  return new PageRealm(handles);
}

/** A class, not a closure, for the same reason the session is one: it owns handles and must close
 * them exactly once. */
class PageRealm implements Realm {
  #cdp: CDPSession;
  #page: Page;
  #browser: PlaywrightBrowser;
  // Nothing listens until somebody asks for DevTools, and then one proxy serves every window.
  #proxy: Proxy | null = null;

  constructor(handles: { cdp: CDPSession; page: Page; browser: PlaywrightBrowser }) {
    this.#cdp = handles.cdp;
    this.#page = handles.page;
    this.#browser = handles.browser;
  }

  send<T = void>(method: string, params?: Record<string, unknown>): Promise<T> {
    // playwright types `send` against its own generated protocol map, which is exactly the
    // knowledge this interface exists to spare its callers.
    return (this.#cdp.send as (method: string, params?: unknown) => Promise<T>)(method, params);
  }

  on(event: string, handler: (params: never) => void): void {
    // playwright's `on` carries three overloads for its own lifecycle events, none of which a
    // realm forwards.
    (this.#cdp.on as (event: string, handler: (params: never) => void) => unknown)(event, handler);
  }

  alive(): boolean {
    return this.#browser.isConnected() && !this.#page.isClosed();
  }

  async reload(): Promise<void> {
    await this.#page.reload();
  }

  async inspectable(): Promise<boolean> {
    return (await this.#debuggingTarget()) !== null;
  }

  /**
   * Chrome's own DevTools frontend, pointed at this session's page — what `/repl` redirects to.
   *
   * The frontend is Chrome's own, served from its port. Its socket is not: a browser sends an
   * `Origin` header and Chrome answers 403 to any debugger connection that has one, so it goes
   * through a proxy that connects onward from Node, where there is none to object to. The proxy
   * is made on first use and closed with the realm.
   */
  async devtoolsURL(): Promise<string | null> {
    const found = await this.#debuggingTarget();
    if (found === null) return null;
    this.#proxy ??= await proxyTo(`ws://127.0.0.1:${found.port}/devtools/page/${found.target}`);

    return `http://localhost:${found.port}/devtools/inspector.html?ws=${this.#proxy.address}`;
  }

  async detach(): Promise<void> {
    await this.#cdp.detach().catch(() => {});
    // A listening socket outlives the process that forgot it, and this one only exists at all if
    // somebody opened DevTools.
    await this.#proxy?.close();
  }

  closing(): Readonly<Record<string, Promise<unknown>>> {
    return {
      page: this.#page.close().catch(() => {}),
      browser: this.#browser.close(),
      prelaunch: shutdownPrelaunch(),
    };
  }

  /**
   * The pre-launched Chrome's HTTP port and this page's target id, or `null` where DevTools cannot
   * honestly be offered.
   *
   * Null is the answer whenever the pre-launch did not happen — macOS, a headed window, or a
   * browser Playwright launched itself, whose targets are not on that endpoint and whose transport
   * is a pipe with no HTTP endpoint at all. The `/json/list` check is what proves the target this
   * session drives is one THAT Chrome knows about.
   */
  async #debuggingTarget(): Promise<{ port: string; target: string } | null> {
    const endpoint = (await prelaunchPromise())?.cdpEndpoint;
    const port = endpoint === undefined ? null : new URL(endpoint).port;
    if (port === null || port === '') return null;

    const info = await this.send<{ targetInfo?: { targetId?: string } }>(
      'Target.getTargetInfo',
    ).catch(() => null);
    const target = info?.targetInfo?.targetId;
    if (target === undefined) return null;

    const listed = (await fetch(`http://localhost:${port}/json/list`)
      .then((answer) => answer.json())
      .catch(() => null)) as Array<{ id?: string }> | null;

    return Array.isArray(listed) && listed.some((known) => known.id === target)
      ? { port, target }
      : null;
  }
}
