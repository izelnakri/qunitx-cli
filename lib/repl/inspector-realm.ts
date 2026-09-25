import * as Chrome from '../chrome/index.ts';
import { connect } from './inspector/client.ts';
import { spawn } from './inspector/spawn.ts';
import type { InspectorClient } from './inspector/client.ts';
import type { InspectedRuntime } from './inspector/spawn.ts';
import type { RuntimeName } from '../setup/targets.ts';
import type { EarlyChrome } from '../types.ts';
import type { Realm } from './realm.ts';

/**
 * A {@link Realm} that is a `node` or `deno` process rather than a page.
 *
 * The same protocol, a different thing on the end of it. What a prompt asks for — evaluate this,
 * tell me when you stop, what is in this scope — both runtimes answer exactly as a page does; what
 * they do not have is a document, and nothing in a prompt needs one.
 *
 * What comes back is STOPPED, before its first statement — the caller registers its handlers and
 * enables the domains it wants, and then calls {@link RuntimeRealm.release}. Handing back a
 * running process would mean the prelude, the preloads and any breakpoint in them raced the
 * prompt that was still setting itself up.
 *
 * ```ts
 * import { inspectorRealm } from './inspector-realm.ts';
 *
 * // Defined, not invoked: it starts a process.
 * async function example(cwd: string) {
 *   const realm = await inspectorRealm('node', cwd, 'globalThis.ready = true;');
 *   await realm.send('Runtime.enable');
 *   await realm.release();
 *
 *   return realm.alive(); // true
 * }
 * ```
 */
export async function inspectorRealm(
  runtime: RuntimeName,
  cwd: string,
  prelude: string,
): Promise<RuntimeRealm> {
  const started = await spawn(runtime, cwd);

  return new Runtime(runtime, cwd, prelude, started, await connect(started.inspectorURL));
}

/** A {@link Realm} that knows which runtime it is — which the banner and `.url` both ask. */
export interface RuntimeRealm extends Realm {
  /** `node` or `deno`, for what is printed where a page would have shown an origin. */
  readonly runtime: RuntimeName;
  /**
   * Lets the runtime past its break-on-start, and installs the prompt's prelude in it.
   *
   * Called once the caller's handlers are registered and its domains enabled. Two steps rather
   * than one, and neither is optional: `Runtime.runIfWaitingForDebugger` releases the WAIT, and
   * the runtime then stops again on its first statement — as a `Debugger.paused` event, with the
   * event loop still frozen until something answers it. A `runIfWaitingForDebugger` alone leaves a
   * process that looks attached, answers synchronous evaluations, and hangs on every `await`.
   */
  release(): Promise<void>;
}

// A class, not a closure, for the same reason the session is one: it owns a process and a socket
// and must end them exactly once.
class Runtime implements RuntimeRealm {
  #runtime: RuntimeName;
  #cwd: string;
  // Kept because a reload re-spawns: the new process needs the same prelude the first one got.
  #prelude: string;
  #started: InspectedRuntime;
  #client: InspectorClient;
  // Kept so a restart can put them back: the session subscribed once, to a socket that a reload
  // replaces underneath it.
  #listeners: Array<[string, (params: never) => void]> = [];
  // Chrome, if anybody ever asks for DevTools. Not for driving anything — purely as the web server
  // that has the DevTools frontend on it.
  #frontend: EarlyChrome | null = null;

  constructor(
    runtime: RuntimeName,
    cwd: string,
    prelude: string,
    started: InspectedRuntime,
    client: InspectorClient,
  ) {
    this.#runtime = runtime;
    this.#cwd = cwd;
    this.#prelude = prelude;
    this.#started = started;
    this.#client = client;
  }

  /** Which runtime this is, for the banner and for what `.url` says instead of an origin. */
  get runtime(): RuntimeName {
    return this.#runtime;
  }

  send<T = void>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.#client.send<T>(method, params);
  }

  on(event: string, handler: (params: never) => void): void {
    this.#listeners.push([event, handler]);
    this.#client.on(event, handler);
  }

  alive(): boolean {
    return this.#started.process.exitCode === null && !this.#started.process.killed;
  }

  /**
   * A reload is a new process.
   *
   * A page reload re-fetches and re-evaluates in a realm the browser makes fresh; there is no
   * lighter way to do the same to a runtime, and pretending otherwise — deleting globals, clearing
   * a module cache — would leave a scope that only looks empty. The socket is replaced, so every
   * listener the session registered is put back on the new one.
   */
  async reload(): Promise<void> {
    await this.#started.shutdown();
    this.#started = await spawn(this.#runtime, this.#cwd);
    this.#client = await connect(this.#started.inspectorURL);
    for (const [event, handler] of this.#listeners) this.#client.on(event, handler);
    // The domains too: they were enabled on a socket that no longer exists, and without
    // `Debugger.enable` a `debugger` statement in a reloaded file is a no-op again.
    await this.send('Runtime.enable');
    await this.send('Debugger.enable');
    await this.release();
  }

  async release(): Promise<void> {
    const client = this.#client;
    const started = new Promise<void>((resume) => {
      let released = false;
      client.on('Debugger.paused', () => {
        if (released) return;
        released = true;
        void client.send('Debugger.resume').then(() => resume());
      });
    });
    await this.send('Runtime.runIfWaitingForDebugger');
    await started;
    // After the resume, not before: the prelude is ordinary code, and code does not run in a
    // process whose event loop has not started.
    await this.send('Runtime.evaluate', { expression: this.#prelude });
  }

  /** Whether Chrome is here to serve a DevTools frontend. Nothing is started to find out. */
  async inspectable(): Promise<boolean> {
    return (await Chrome.find()) !== null;
  }

  /**
   * Chrome's own DevTools, attached to this runtime — the same window `chrome://inspect` opens,
   * at an address that can simply be visited.
   *
   * Chrome's remote-debugging port is also an HTTP server, and what it serves includes the
   * DevTools frontend itself. So a headless Chrome is started for that and only that: it inspects
   * nothing, drives nothing, and exists because the frontend has to be served from somewhere. The
   * `v8only=true` is what tells the frontend it is looking at a runtime rather than a page, so it
   * opens on Console and Sources with no Elements tab to be confused by.
   *
   * No proxy, unlike the page realm. Chrome answers 403 to a debugger socket carrying an `Origin`
   * header; a node inspector validates `Host` and ignores `Origin`, so the frontend can talk to it
   * directly. Started on first ask, because most sessions never ask.
   */
  async devtoolsURL(): Promise<string | null> {
    this.#frontend ??= await Chrome.spawn(await Chrome.find(), Chrome.CHROMIUM_ARGS, true);
    if (this.#frontend === null) return null;

    const port = new URL(this.#frontend.cdpEndpoint).port;
    // `ws=` takes host, port and path with no scheme in front of it.
    const socket = this.#started.inspectorURL.replace(/^ws:\/\//, '');

    return `http://127.0.0.1:${port}/devtools/js_app.html?v8only=true&ws=${socket}`;
  }

  detach(): Promise<void> {
    this.#client.close();

    return Promise.resolve();
  }

  closing(): Readonly<Record<string, Promise<unknown>>> {
    return {
      runtime: this.#started.shutdown(),
      ...(this.#frontend === null ? {} : { devtoolsHost: this.#frontend.shutdown() }),
    };
  }
}
