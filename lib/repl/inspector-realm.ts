import { pathToFileURL } from 'node:url';
import * as Chrome from '../chrome/index.ts';
import { connect } from './inspector/client.ts';
import { spawn } from './inspector/spawn.ts';
import type { InspectorClient } from './inspector/client.ts';
import type { InspectedRuntime } from './inspector/spawn.ts';
import type { RuntimeName } from '../setup/targets.ts';
import type { EarlyChrome } from '../types.ts';
import type { BreakpointTarget, Realm } from './realm.ts';

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
 *   // `Debugger.enable` first: `release` waits for a pause that is not delivered without it.
 *   await realm.send('Debugger.enable');
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
  try {
    return new Runtime(runtime, cwd, prelude, started, await connect(started.inspectorURL));
  } catch (error) {
    // A node inspector takes ONE debugger session, so a leftover `chrome://inspect` is enough to
    // refuse this handshake. Nothing else holds the child at this point, and it is stopped at its
    // first line holding a port, so it would hold it for the life of the machine.
    await started.shutdown();
    throw error;
  }
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
  // Memoised as a PROMISE rather than a handle: `??=` reads before the await and assigns after it,
  // so two overlapping `/repl` hits each saw null, each started a Chrome, and the loser — with its
  // own temp profile under os.tmpdir() — was never shut down again.
  #frontend: Promise<EarlyChrome | null> | null = null;

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

  /** A runtime imports files, which is the whole reason its breakpoints are simple. */
  readonly importsFromDisk = true;

  /**
   * The file, and the line as typed.
   *
   * No source map, because there is no bundle to find the line inside of — the runtime loaded
   * that file and V8 knows it by its own `file://` URL. Type-stripping shifts nothing: node and
   * deno both blank types in place rather than reformatting, so line 12 stays line 12.
   *
   * CDP counts from zero and people count from one, which is the only arithmetic here.
   */
  breakpointAt(absolute: string, shown: string, line: number): BreakpointTarget | string {
    if (line < 1) return `${shown}:${line} is not a line number`;

    return {
      url: pathToFileURL(absolute).href,
      lineNumber: line - 1,
      columnNumber: 0,
      sourceLine: line,
    };
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
    // The old socket first. Left open it survives until the killed process drops the connection,
    // and one is added per reload.
    this.#client.close();
    await this.#started.shutdown();
    this.#started = await spawn(this.#runtime, this.#cwd);
    this.#client = await connect(this.#started.inspectorURL);
    // The listeners come back in two halves, and which half goes where is load-bearing.
    //
    // Everything EXCEPT `Debugger.paused` goes back first, because `Debugger.enable` replays a
    // `scriptParsed` for every script already parsed and a subscriber added afterwards misses that
    // replay — which is the note `session.ts` keeps beside its own registration order.
    for (const [event, handler] of this.#listeners) {
      if (event !== 'Debugger.paused') this.#client.on(event, handler);
    }
    // Without `Debugger.enable` a `debugger` statement in a reloaded file is a no-op again.
    await this.send('Runtime.enable');
    await this.send('Debugger.enable');
    // `Debugger.paused` stays off until the break-on-start has been consumed. The re-spawned
    // runtime stops on its first statement, and that stop belongs to this realm — a session
    // handler attached in time to see it reads a frame inside the host module, calls it a
    // breakpoint, and then answers `Can only perform operation while paused` to everything typed
    // afterwards.
    await this.release();
    for (const [event, handler] of this.#listeners) {
      if (event === 'Debugger.paused') this.#client.on(event, handler);
    }
  }

  async release(): Promise<void> {
    const client = this.#client;
    // `Debugger.enable` must already have been sent, or the pause below is never delivered and
    // this waits for it forever. `start()` and `reload()` both send it first.
    const stopped = new Promise<void>((resume, fail) => {
      const released = (): void => {
        client.off('Debugger.paused', released);
        client.send('Debugger.resume').then(() => resume(), fail);
      };
      client.on('Debugger.paused', released);
      // A runtime that dies between the pause and the resume would otherwise leave this pending
      // and the prompt with it — there is deliberately no timeout anywhere below this.
      client.on('Inspector.detached', () => fail(new Error('the runtime went away')));
    });
    await this.send('Runtime.runIfWaitingForDebugger');
    await stopped;
    // After the resume, not before: the prelude is ordinary code, and code does not run in a
    // process whose event loop has not started.
    const installed = await this.send<{ exceptionDetails?: { text: string } }>('Runtime.evaluate', {
      expression: this.#prelude,
    });
    if (installed.exceptionDetails) {
      throw new Error(`the prompt's prelude threw — ${installed.exceptionDetails.text}`);
    }
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
    this.#frontend ??= Chrome.find().then((path) => Chrome.spawn(path, Chrome.CHROMIUM_ARGS, true));
    const frontend = await this.#frontend;
    if (frontend === null) return null;

    const port = new URL(frontend.cdpEndpoint).port;
    // `ws=` takes host, port and path with no scheme in front of it.
    const socket = this.#started.inspectorURL.replace(/^ws:\/\//, '');

    return `http://127.0.0.1:${port}/devtools/js_app.html?v8only=true&ws=${socket}`;
  }

  detach(): Promise<void> {
    this.#client.close();

    return Promise.resolve();
  }

  closing(): Readonly<Record<string, Promise<unknown>>> {
    const frontend = this.#frontend;

    return {
      runtime: this.#started.shutdown(),
      ...(frontend === null ? {} : { devtoolsHost: frontend.then((chrome) => chrome?.shutdown()) }),
    };
  }
}
