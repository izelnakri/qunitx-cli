import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import * as Browser from '../setup/browser.ts';
import * as WebServer from '../setup/web-server.ts';
import * as Reporter from '../reporters/index.ts';
import * as SourceMap from '../utils/source-map.ts';
import * as Source from './source.ts';
import * as Args from '../args/index.ts';
import * as FSTree from '../setup/fs-tree.ts';
import * as TestFilePaths from '../setup/test-file-paths.ts';
import { bindServerToPort } from '../setup/bind-server-to-port.ts';
import { qunitxRuntimePlugin } from '../setup/qunitx-runtime-plugin.ts';
import { shutdownPrelaunch } from '../chrome/prelaunch.ts';
import { closeWithGrace } from '../utils/close-with-grace.ts';
import { Failure } from '../task/index.ts';
import { harness } from '../setup/qunit-harness.ts';
import { inspect } from './inspect.ts';
import { colorEnabled } from '../utils/color.ts';
import type { Browser as PlaywrightBrowser, CDPSession, Page } from 'playwright-core';
import type { HTTPServer } from '../web/index.ts';
import type { Config } from '../types.ts';
import type { TestDetails } from '../reporters/types.ts';

// Every object the page hands back is retained until it is released, and a REPL is a long
// conversation — so each evaluation frees the previous one's handles by group before making more.
const OBJECT_GROUP = 'qunitx-repl';
// Where a breakpoint's own declarations are kept for as long as it lasts. On the page rather than
// in this process, because their values are the page's — a DOM node declared at a breakpoint has
// to still be that node on the next line.
const HOLDER = 'globalThis.__qunitxPaused';
// Kept apart from the group an evaluation uses: a preview is discarded on the next keystroke, and
// releasing it must never take a handle the prompt is still rendering with.
const PREVIEW_GROUP = 'qunitx-repl-preview';
// A preview is worth milliseconds and no more — it is an aside, and the typing continues either way.
const PREVIEW_TIMEOUT_MS = 100;
// How long a step waits for the page to stop again. V8 stops at the next statement, so this is a
// backstop for the step that never arrives rather than a budget anything normally spends.
const STEP_TIMEOUT_MS = 2_000;
const STEPS: Record<StepKind, 'Debugger.stepInto' | 'Debugger.stepOver' | 'Debugger.stepOut'> = {
  into: 'Debugger.stepInto',
  over: 'Debugger.stepOver',
  out: 'Debugger.stepOut',
};
// A dotted path of plain identifiers, and nothing else. What completion is allowed to evaluate.
const PATH = /^[\p{ID_Start}_$][\p{ID_Continue}$]*(\.[\p{ID_Start}_$][\p{ID_Continue}$]*)*$/u;
// The scopes a breakpoint is about: the frame being executed and the blocks inside it.
const LOCAL_SCOPES = new Set(['local', 'block', 'catch', 'with']);
// Could this input have bound a name? A declaration keyword, or an `=` that is not a comparison.
// Deliberately generous — a false yes costs one round trip, a false no loses where a name came
// from, and only one of those is recoverable.
const BINDS = /\b(?:var|let|const|function|class|import)\b|(?<![=!<>])=(?!=)/;
// Bounds the harness calls only, never a user's own expression: a slow test is QUnit's
// `testTimeout` to enforce, and this is the backstop for a page that stops answering entirely.
// Typed input is deliberately unbounded — `interrupt()` is how you stop it.
const HARNESS_TIMEOUT_MS = 120_000;

/**
 * The REPL evaluates over the Chrome DevTools Protocol, which firefox and webkit do not speak.
 *
 * ```ts
 * import { UnsupportedBrowser } from './session.ts';
 *
 * const failure = UnsupportedBrowser({ browser: 'webkit' });
 * failure.data.browser; // 'webkit' — the engine that was asked for
 * ```
 */
export const UnsupportedBrowser: Failure.FailureFactory<'UnsupportedBrowser', { browser: string }> =
  Failure.define(
    'UnsupportedBrowser',
    (data: { browser: string }) =>
      `qunitx repl evaluates over the Chrome DevTools Protocol, so it needs --browser=chromium (got ${data.browser})`,
  );

/**
 * A file the REPL was asked to preload would not compile.
 *
 * Separate from the run pipeline's bundle error because the consequence differs: a run has nothing
 * to do without its bundle, while a REPL could in principle still open. It does not — a prompt
 * whose `import` silently did not happen is worse than one that refuses to start.
 *
 * ```ts
 * import { PreloadBuildFailed } from './session.ts';
 *
 * const failure = PreloadBuildFailed({ detail: 'test/helpers.ts:3:8: ERROR: Expected ")"' });
 * failure.data.detail.includes('ERROR'); // true — esbuild's own message, verbatim
 * ```
 */
export const PreloadBuildFailed: Failure.FailureFactory<'PreloadBuildFailed', { detail: string }> =
  Failure.define(
    'PreloadBuildFailed',
    (data: { detail: string }) => `qunitx repl could not bundle its inputs — ${data.detail}`,
  );

/** Everything starting a REPL can fail with, beyond config assembly. */
export type ReplStartFailure =
  Failure.Of<typeof UnsupportedBrowser> | Failure.Of<typeof PreloadBuildFailed>;

/**
 * What one input produced. `output` is already rendered — the terminal prints it verbatim — and
 * the rest is there so a caller can react rather than parse.
 *
 * ```ts
 * const result: ReplResult = { output: '2', failed: false, incomplete: false, tests: [] };
 * result.incomplete; // false — a true here means "unfinished input", not "no value"
 * ```
 */
export interface ReplResult {
  /** The rendered value, or the error and its source-mapped stack. Empty when there is nothing to print. */
  output: string;
  /** The input threw; `output` is the error. */
  failed: boolean;
  /** The input was unfinished (`const a = {`), so nothing ran and the terminal should read on. */
  incomplete: boolean;
  /** Tests QUnit ran because of this input. Already reported through the session's reporters. */
  tests: TestDetails[];
  /**
   * Where the input stopped at a `debugger` statement, or absent when it ran to completion.
   *
   * The page is still stopped when this comes back. Whatever is typed next runs in that frame, and
   * {@link ReplSession.resume} is what lets it carry on.
   */
  pausedAt?: string;
}

/**
 * One thing in scope: what it is called, what it holds, and where it came from.
 *
 * `value` is already rendered — by the same renderer the prompt prints values with, so a string in
 * a scope listing is quoted and coloured exactly as it would be if you had typed its name.
 *
 * ```ts
 * const entry: ScopeEntry = { name: 'label', value: "'one'", where: 'line 1' };
 * entry.where; // 'line 1' — the input that declared it, or the file it was preloaded from
 * ```
 */
export interface ScopeEntry {
  /** The name it is bound to. */
  name: string;
  /** The rendered value, coloured when the terminal takes colour. */
  value: string;
  /** Where it came from, or `''` where nothing knows. */
  where: string;
}

/** One step, named the way gdb names it: `step`, `next`, `finish`. */
export type StepKind = 'into' | 'over' | 'out';

/**
 * A live REPL: one browser page, kept open, that evaluates what you type.
 *
 * The page is the point. Bindings, the DOM, timers, module state and QUnit's registry all persist
 * between inputs, so a session is a conversation with one running document rather than a series of
 * unrelated evaluations.
 *
 * ```ts
 * // Defined, not invoked: a real session owns a browser and a bound port.
 * async function askOnce(session: ReplSession) {
 *   const answer = await session.evaluate('document.title');
 *   await session.close();
 *   return answer.output;
 * }
 * ```
 */
export interface ReplSession {
  /** Where the page is served, e.g. `http://localhost:1234`. */
  url: string;
  /** `[file, exported names]` per preloaded module — what the terminal lists on start-up. */
  loaded: Array<[string, string[]]>;
  /**
   * Evaluates one input in the page and resolves with what to print.
   *
   * Tests the input registered are run before this resolves and reported as they finish, so the
   * TAP for a test typed at the prompt lands ahead of the value — where a reader expects it.
   */
  evaluate(input: string): Promise<ReplResult>;
  /**
   * Resolves once nothing is in flight — a no-op at the back of the evaluation queue.
   *
   * What closing is awaited through. Lines pasted into a terminal arrive as one chunk and are read
   * as several, so a `.exit` at the end of a paste can otherwise reach the browser before the
   * evaluations above it have answered.
   */
  settled(): Promise<void>;
  /**
   * The identifiers the page can complete with: everything on `base`, or what is in scope at top
   * level when `base` is `''`.
   *
   * What both the suggestion and TAB are drawn from, so the two agree by construction rather than
   * by two lists kept in step. Resolves empty for anything it cannot answer — a base that is not a
   * plain dotted path, a closed session — because a completion is a convenience and never a reason
   * for a prompt to report an error.
   */
  names(base: string): Promise<string[]>;
  /**
   * What the input WOULD evaluate to, or `''` where it cannot be known without doing something.
   *
   * V8 refuses to run anything with a side effect for this: an assignment, a declaration, a call
   * that mutates. That refusal is the feature — an answer offered before Enter has to be free, and
   * `deleteEverything()` typed at a prompt must not delete everything because it was typed.
   */
  preview(input: string): Promise<string>;
  /**
   * What this session has added to the page's globals — not the several hundred a browser starts
   * with, which is a list nobody reads.
   *
   * Preloaded exports are in it too, attributed to the file they came from.
   */
  scope(): Promise<ScopeEntry[]>;
  /**
   * What is in scope at the breakpoint, innermost first, or empty when the page is not paused.
   *
   * Read out of the stopped frame rather than evaluated, because a paused isolate runs nothing —
   * asking it to would hang the one command a breakpoint exists for.
   */
  locals(): Promise<ScopeEntry[]>;
  /** Reloads the page: every binding and all page state goes, the session stays. */
  reload(): Promise<void>;
  /** Stops whatever is executing in the page — the Ctrl-C of a runaway expression. */
  interrupt(): Promise<void>;
  /**
   * Where the page is stopped at a `debugger` statement, or `null` when it is running.
   *
   * While this is set, {@link ReplSession.evaluate} runs in the PAUSED frame, so what you type
   * sees the locals at the breakpoint rather than the globals around it.
   */
  pausedAt: string | null;
  /**
   * The source the breakpoint is in and the line it stopped on, or `null` when nothing is stopped.
   *
   * The ORIGINAL source where there is one: a pause inside a preloaded file reports that file and
   * its own line numbers rather than the bundle's. Typed-in functions have no file, and their
   * source comes back from the page, which is the only place it exists.
   */
  frameSource(): Promise<{ text: string; line: number } | null>;
  /**
   * Runs one step and stops again, reporting where — or `null` if the page did not stop.
   *
   * `into` enters the next call, `over` runs it without entering, `out` runs until the current
   * frame returns: `step`, `next` and `finish` as every debugger since gdb has named them.
   *
   * Stepping is also the only way INTO another frame from here. A `debugger` statement inside
   * something you call at a breakpoint does nothing, because V8 disables breakpoints for the
   * duration of a debugger evaluation — nothing this REPL can turn on.
   */
  step(kind: StepKind): Promise<string | null>;
  /** Lets a paused page carry on. A no-op when it is not paused. */
  resume(): Promise<void>;
  /** Closes the page, the browser and the server. Idempotent. */
  close(): Promise<void>;
  /** Closes the session at the end of an `await using` block. */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Starts a REPL for an assembled config: bundles `qunitx` and the preload files, serves it, opens a
 * page on it, and attaches to that page over CDP.
 *
 * `preload` is passed rather than read off `config.fsTree` because the two mean different things.
 * The fsTree is what a RUN would execute — inputs plus `package.json#qunitx.inputs` — and a prompt
 * that ran your whole suite before appearing is not what `qunitx repl` means. Only files named on
 * this invocation are loaded.
 *
 * `onOpen` fires once the page is up and {@link ReplSession.loaded} is known, before the preloaded
 * files' own tests run. That ordering is the whole reason it exists: the CLI announces the session
 * there, and without it the first thing a user saw was TAP from a session that had not introduced
 * itself yet.
 *
 * ```ts
 * import * as Repl from './session.ts';
 *
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: launches a browser and binds a port.
 * async function open(config: Config) {
 *   await using session = await Repl.start(config, []);
 *   return session.url;
 * }
 * ```
 */
export async function start(
  config: Config,
  preload: string[] = [],
  onOpen?: (session: ReplSession) => void,
): Promise<ReplSession> {
  if (config.browser !== 'chromium') throw UnsupportedBrowser({ browser: config.browser });

  const build = config.state.group.build;
  const outDir = path.resolve(config.projectRoot, config.output);
  build.allTestCode = await bundle(config, preload, outDir);
  // Served as `/tests.js` below, which is the URL the frame resolver recognises — so a stack from
  // a preloaded file maps back to its own source, exactly as it does in a run.
  config.state.group.sourceMapDecoder = SourceMap.extractInline(build.allTestCode, outDir);

  // The run's own server, for its asset routes and its `/tests.js`. Only `/` is replaced, and it
  // has to be: the page a run serves starts QUnit the moment it loads, which is the one thing a
  // REPL must not do. Routes are keyed by path, so the later registration is the one that serves.
  const server = WebServer.setup(config);
  server.get('/', (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end(pageHTML(config));
  });

  const browser = await Browser.launch(config);
  try {
    const page = await browser.newPage();
    await bindServerToPort(server, config);
    const url = `http://localhost:${config.port}`;
    await page.addInitScript({ content: initScript(config) });
    await page.goto(url);

    const cdp = await page.context().newCDPSession(page);
    cdp.on('Runtime.consoleAPICalled', (event) => {
      // The page's own output, on the SAME CDP session as the evaluations — so it arrives in the
      // order it was produced rather than racing the result it belongs to.
      Reporter.browserLog(config, {
        type: event.type,
        // A string argument prints as itself — `console.log('hi')` is text, not a value being
        // shown — which is the one place this differs from rendering a result.
        text: event.args
          .map((arg) => (arg.type === 'string' ? String(arg.value) : describe(arg)))
          .join(' '),
        args: [],
      });
    });
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      const text = exceptionDetails.exception?.description ?? exceptionDetails.text;
      Reporter.browserLog(config, {
        type: 'pageerror',
        text: resolveStack(config, text),
        args: [],
      });
    });
    // BEFORE `Debugger.enable`, which replays a `scriptParsed` for everything already loaded — the
    // bundle among them. Registering after the enable misses that replay, and a pause inside a
    // preloaded file could then only report a bundle line.
    const scripts = new Map<string, string>();
    cdp.on('Debugger.scriptParsed', (event) => {
      if (event.url) scripts.set(event.scriptId, event.url);
    });
    await cdp.send('Runtime.enable');
    // What makes `debugger` mean something here. Without a debugger attached the statement is a
    // no-op — the page runs straight past it — so a prompt that never enables this can only ever
    // answer `undefined` to it. Enabled for the session rather than on demand, because a statement
    // already executing is too late to start listening for.
    await cdp.send('Debugger.enable');

    const session = new Session(config, { cdp, page, server, browser, url });
    cdp.on('Debugger.paused', (event) => session.onPaused(event, scripts));
    session.loaded = await session.readLoaded();
    await session.takeBaseline();
    onOpen?.(session);
    await session.runPending();

    return session;
  } catch (error) {
    // A start that fails after the browser is up — a page that will not navigate, a bundle whose
    // top level throws — still holds a browser and a bound port, and nothing else will release
    // them: `close()` belongs to the session this never returned.
    await closeWithGrace([server.close(), browser.close(), shutdownPrelaunch()]);
    throw error;
  }
}

/**
 * The files a `qunitx repl <inputs>` invocation should preload, resolved the way a run resolves
 * its targets — directories walked, globs expanded, extensions honoured.
 *
 * Lives here rather than at each entry point so the CLI and the JS API cannot drift on what
 * "preload" means. Idempotent for already-absolute inputs, so either caller's spelling works.
 *
 * ```ts
 * import * as Repl from './session.ts';
 *
 * import type { Config } from '../types.ts';
 *
 * // Defined, not invoked: walks the real filesystem.
 * async function preloads(config: Config) {
 *   return await Repl.resolvePreload(config, ['test/helpers.ts']);
 * }
 * ```
 */
export async function resolvePreload(config: Config, inputs: readonly string[]): Promise<string[]> {
  if (inputs.length === 0) return [];
  const absolute = Args.applyInputs({ inputs: [] }, config.projectRoot, config.cwd, inputs).inputs;

  return Object.keys(await FSTree.build(TestFilePaths.setup(absolute), config));
}

/** Returned by the race in `#evaluate` when the page stopped instead of answering. */
const PAUSED = { paused: true } as unknown as EvaluateResult;

/** The live session. A class because it owns handles and must close them exactly once. */
class Session implements ReplSession {
  url: string;
  loaded: Array<[string, string[]]> = [];
  #config: Config;
  #cdp: CDPSession;
  // The frame a `debugger` statement stopped in, and the notice describing where. Both null while
  // the page is running, and set together — one is the capability, the other is what to print.
  #frameId: string | null = null;
  #pausedAt: string | null = null;
  // The stopped frame's scope chain, kept from the pause event: `Runtime.getProperties` on these
  // reads a stopped isolate without running anything in it.
  #scopes: PausedScope[] = [];
  // What has been declared at this breakpoint, and whether each belongs to the block it was
  // written in. The values live in a holder on the page and reach the next input as function
  // ARGUMENTS, which is the only thing that shadows an outer binding of the same name — a global
  // property cannot, because a top-level `let` is a global LEXICAL binding and wins over one.
  #pausedBindings = new Map<string, boolean>();
  // Where the breakpoint is, kept from the pause event so the source can be fetched when asked
  // for rather than on every stop.
  #pausedIn: { file: string | null; scriptId: string; line: number } | null = null;
  // What the page had in scope before anybody typed, so `.scope` can show what this session added
  // rather than everything a browser ships with.
  #baseline = new Set<string>();
  // Name to where it came from. Filled by diffing after an input that could have bound something,
  // which is the only moment the answer is knowable.
  #origins = new Map<string, string>();
  #inputs = 0;
  // Resolves the evaluation that was in flight when the pause happened. `Runtime.evaluate` does not
  // return while the page is stopped, so without this the prompt never comes back.
  #announcePause: ((result: ReplResult) => void) | null = null;
  // Resolves the step that is waiting for the page to stop again. Separate from the one above
  // because a step has no evaluation in flight to answer — it is waiting on the pause itself.
  #announceStep: (() => void) | null = null;
  #page: Page;
  #server: HTTPServer;
  #browser: PlaywrightBrowser;
  #closed = false;
  // Evaluations are serialized: two in flight would interleave their test batches, and "which run
  // did this `ok 2` come from" is not a question a prompt should be able to raise.
  #tail: Promise<unknown> = Promise.resolve();

  constructor(
    config: Config,
    handles: {
      cdp: CDPSession;
      page: Page;
      server: HTTPServer;
      browser: PlaywrightBrowser;
      url: string;
    },
  ) {
    this.#config = config;
    this.#cdp = handles.cdp;
    this.#page = handles.page;
    this.#server = handles.server;
    this.#browser = handles.browser;
    this.url = handles.url;
  }

  evaluate(input: string): Promise<ReplResult> {
    const next = this.#tail.then(() => this.#evaluate(input));
    this.#tail = next.then(
      () => {},
      () => {},
    );

    return next;
  }

  settled(): Promise<void> {
    return this.#tail.then(
      () => {},
      () => {},
    );
  }

  async names(base: string): Promise<string[]> {
    // Re-checked here and not only in the caller: this interpolates `base` into source that the
    // page then runs, and it runs on a KEYSTROKE. A path of plain identifiers can trip a getter,
    // which is inherent to answering the question at all; anything else could be a function call
    // nobody asked to make.
    if (this.#closed || (base !== '' && !PATH.test(base))) return [];

    const target = base === '' ? 'globalThis' : base;
    // The whole prototype chain, because `document.qu` is finished by `Node.prototype`'s methods
    // as surely as by the element's own. Own-property names rather than `for…in`, so what is there
    // but not enumerable — which is most of the DOM — still completes.
    const expression = `(() => {
      try {
        const found = new Set();
        for (let o = ${target}; o != null; o = Object.getPrototypeOf(o)) {
          for (const key of Object.getOwnPropertyNames(o)) found.add(key);
        }
        return [...found];
      } catch {
        return [];
      }
    })()`;
    const found = await this.#byValue<string[]>(expression);
    if (base !== '') return found;

    // `let`, `const` and `class` at top level live in the global LEXICAL scope, which is not on
    // `globalThis` and is therefore invisible to everything above — and in a REPL it is where half
    // of what you declared ends up. Asked for even while paused: unlike an evaluation, this one
    // reads the isolate rather than running in it, and a stopped isolate answers it.
    const lexical = await this.#cdp
      .send('Runtime.globalLexicalScopeNames', {})
      .then((result) => (result as { names?: string[] }).names ?? [])
      .catch(() => []);

    return [...new Set([...found, ...lexical])];
  }

  /**
   * Remembers what the page had in scope before anybody typed, and who owns the preloaded names.
   *
   * Taken AFTER the bundle has run, so the several hundred names a browser ships with are in it
   * and `.scope` does not read like a DOM reference. The preloaded exports are pulled back out —
   * they are the session's, and the file they came from is a better answer than a line number.
   */
  async takeBaseline(): Promise<void> {
    const exported = new Set(this.loaded.flatMap(([, names]) => names));
    const present = await this.names('');
    this.#baseline = new Set(present.filter((name) => !exported.has(name)));
    this.#origins = new Map(
      this.loaded.flatMap(([file, names]) => names.map((name): [string, string] => [name, file])),
    );
    this.#inputs = 0;
  }

  async scope(): Promise<ScopeEntry[]> {
    const introduced = (await this.names('')).filter((name) => !this.#baseline.has(name));
    if (introduced.length === 0) return [];

    // Rendered in the page, by the renderer the prompt itself prints with — one round trip for
    // every value, and a DOM node in a scope listing reads the way it reads at the prompt.
    // `eval` rather than `globalThis[name]` because `let` and `const` at top level are NOT on
    // `globalThis`; they live in the global lexical scope, which only a reference can reach.
    const rendered = await this.#byValue<Array<[string, string]>>(`(() => {
      return ${JSON.stringify(introduced)}.map((name) => {
        try {
          return [name, globalThis.__qunitxInspect(eval(name))];
        } catch {
          return [name, ''];
        }
      });
    })()`);

    return rendered
      .map(([name, value]) => ({ name, value, where: this.#origins.get(name) ?? '' }))
      .sort((left, right) => introducedAt(left.where) - introducedAt(right.where));
  }

  async locals(): Promise<ScopeEntry[]> {
    const entries: ScopeEntry[] = [];
    // The frame and the blocks inside it, and nothing wider. `global` is what `.scope` answers,
    // and `closure` here is the ESBUILD BUNDLE — every name QUnit and the runtime declare, which
    // buries the handful a breakpoint is actually about under two hundred lines of module scope.
    const readable = this.#scopes.filter((scope) => LOCAL_SCOPES.has(scope.type));
    for (const scope of readable) {
      const objectId = scope.object.objectId;
      if (!objectId) continue;
      const properties = await this.#cdp
        .send('Runtime.getProperties', {
          objectId,
          ownProperties: true,
          generatePreview: true,
        })
        .catch(() => null);
      for (const property of properties?.result ?? []) {
        if (!property.value) continue;
        entries.push({
          name: property.name,
          value: describe(property.value),
          // The block a name belongs to, where that is not the function being executed.
          where: scope.type === 'local' ? '' : (scope.name ?? scope.type),
        });
      }
    }

    return entries;
  }

  async preview(input: string): Promise<string> {
    // Not while stopped: a paused isolate answers no evaluation, and the one thing a breakpoint
    // must not do is stop answering keystrokes.
    if (this.#closed || this.#frameId || input.trim() === '') return '';

    // `throwOnSideEffect` is V8's own answer to this question — it aborts the moment the
    // expression would change anything, which is what makes evaluating on a keystroke safe rather
    // than merely fast. The timeout covers what is pure but slow; a preview is worth milliseconds.
    await this.#cdp
      .send('Runtime.releaseObjectGroup', { objectGroup: PREVIEW_GROUP })
      .catch(() => {});
    const evaluated = (await this.#cdp
      .send('Runtime.evaluate', {
        expression: input,
        throwOnSideEffect: true,
        timeout: PREVIEW_TIMEOUT_MS,
        objectGroup: PREVIEW_GROUP,
        generatePreview: true,
      })
      .catch(() => null)) as EvaluateResult | null;
    if (!evaluated || evaluated.exceptionDetails) return '';

    return await this.#render(evaluated.result);
  }

  async reload(): Promise<void> {
    // A new page has none of it, declared at a breakpoint or otherwise.
    this.#pausedBindings.clear();
    await this.#page.reload();
    this.loaded = await this.readLoaded();
    // A reload is a new page: nothing this session declared survives it, so what counts as "what
    // you added" starts again from what the fresh page has.
    await this.takeBaseline();
    await this.runPending();
  }

  get pausedAt(): string | null {
    return this.#pausedAt;
  }

  /**
   * Lets a paused page carry on.
   *
   * Never automatic. If DevTools is open on the same page it is paused too, and resuming the target
   * from here would step on someone reading their own stack. Whoever paused it says when.
   */
  async frameSource(): Promise<{ text: string; line: number } | null> {
    const at = this.#pausedIn;
    if (!at) return null;

    if (at.file !== null) {
      try {
        return {
          text: fs.readFileSync(path.resolve(this.#config.cwd, at.file), 'utf8'),
          line: at.line,
        };
      } catch {
        // Renamed, deleted, or never on disk. The pause still stands; only the map is missing.
        return null;
      }
    }
    // No file: a function typed at this prompt exists nowhere else, and the page is the only one
    // that can say what it says.
    const fetched = (await this.#cdp
      .send('Debugger.getScriptSource', { scriptId: at.scriptId })
      .catch(() => null)) as { scriptSource?: string } | null;

    return fetched?.scriptSource === undefined
      ? null
      : { text: fetched.scriptSource, line: at.line };
  }

  async step(kind: StepKind): Promise<string | null> {
    if (!this.#pausedAt) return null;

    const stopped = new Promise<void>((resolve) => {
      this.#announceStep = resolve;
    });
    await this.#cdp.send(STEPS[kind]).catch(() => {});
    // Bounded, because a step is not guaranteed to reach another one: stepping out of the last
    // frame runs the page to the end of what it was doing, and a prompt that waited for a pause
    // that is never coming would simply stop answering.
    const again = await Promise.race([
      stopped.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), STEP_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    this.#announceStep = null;
    if (again) return this.#pausedAt;

    // It carried on — but the step did not go away with it. A step request that finds nothing to
    // stop in outlives the run it was made for, and V8 spends it on whatever runs NEXT: type
    // `1 + 1` after stepping off the end of the stack and the prompt stops on it. So it is spent
    // here instead, on a statement that does not matter, with pauses suppressed for exactly as
    // long as that takes.
    await this.#cdp.send('Debugger.setSkipAllPauses', { skip: true }).catch(() => {});
    await this.#cdp.send('Runtime.evaluate', { expression: '0' }).catch(() => {});
    await this.#cdp.send('Debugger.setSkipAllPauses', { skip: false }).catch(() => {});
    await this.#released();

    return null;
  }

  async resume(): Promise<void> {
    if (!this.#pausedAt) return;
    await this.#cdp.send('Debugger.resume').catch(() => {});
    await this.#released();
  }

  /** Everything a pause leaves behind, put away — however the page came to be running again. */
  async #released(): Promise<void> {
    const kept = [...this.#pausedBindings]
      .filter(([, blockScoped]) => !blockScoped)
      .map(([name]) => name);
    const had = this.#pausedBindings.size > 0;
    this.#pausedBindings.clear();
    this.#frameId = null;
    this.#pausedAt = null;
    this.#pausedIn = null;
    this.#scopes = [];
    // After the page is running again, because until it is there is nothing to run this in. What
    // JavaScript hoists out of a block becomes a real global; what belongs to the block goes with
    // it, which leaves the name free for the session to declare its own.
    if (had) {
      await this.#byValue(`(() => {
        const held = ${HOLDER} ?? {};
        for (const name of ${JSON.stringify(kept)}) globalThis[name] = held[name];
        delete ${HOLDER};
        return [];
      })()`);
    }
  }

  /**
   * The page stopped at a `debugger` statement.
   *
   * Two things have to happen. The frame is kept, so what gets typed next can be evaluated INSIDE
   * it. And the evaluation that was in flight is answered — `Runtime.evaluate` does not return
   * while the page is stopped, so the prompt would otherwise never come back to say so.
   */
  onPaused(event: DebuggerPaused, scripts: Map<string, string>): void {
    const frame = event.callFrames[0];
    this.#frameId = frame?.callFrameId ?? null;
    this.#pausedAt = describeFrame(this.#config, frame, scripts);
    const located = frame && mappedLocation(this.#config, frame, scripts);
    this.#pausedIn = frame
      ? {
          file: located?.file ?? null,
          scriptId: frame.location.scriptId,
          line: located?.line ?? frame.location.lineNumber + 1,
        }
      : null;
    // Only the frame the prompt evaluates in. The scopes further up the stack belong to callers
    // nothing typed here can see, and listing them would answer a question nobody asked.
    this.#scopes = frame?.scopeChain ?? [];
    const stepped = this.#announceStep;
    this.#announceStep = null;
    stepped?.();
    const announce = this.#announcePause;
    this.#announcePause = null;
    announce?.({
      output: '',
      failed: false,
      incomplete: false,
      tests: [],
      pausedAt: this.#pausedAt,
    });
  }

  interrupt(): Promise<void> {
    // Terminates whatever is running in the page's isolate, so the pending `Runtime.evaluate`
    // comes back as a thrown "Execution terminated" rather than never coming back at all.
    return this.#cdp.send('Runtime.terminateExecution').then(
      () => {},
      () => {},
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // BEFORE the rest, and awaited on its own: a detach whose page is already going away never
    // settles — it cost the full cleanup grace on every exit until it was moved up here. With the
    // page still alive it answers in single-digit milliseconds.
    await this.#cdp.detach().catch(() => {});
    await closeWithGrace([
      this.#page.close().catch(() => {}),
      this.#server.close(),
      this.#browser.close(),
      shutdownPrelaunch(),
      // Deliberately NOT `esbuild.stop()`, though a REPL is exactly the kind of program that ends
      // by handing the event loop back: esbuild's `--service` child does not hold it open (checked
      // — `test/fixtures/repl-handles.ts` exits either way), and stopping the shared service would
      // reach past this session into whatever else in the process is using esbuild.
    ]);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /** What the page's bundle loaded: `[file, exported names]` per preloaded module. */
  readLoaded(): Promise<Array<[string, string[]]>> {
    return this.#harness<Array<[string, string[]]>>('loaded');
  }

  /** Runs the tests registered but not yet run, reporting each as it finishes. */
  async runPending(): Promise<TestDetails[]> {
    const payload = await this.#harness<string | null>('flush()');
    if (!payload) return [];
    const { tests } = JSON.parse(payload) as { tests: TestDetails[] };
    for (const details of tests) Reporter.testEnd(this.#config, details);

    return tests;
  }

  async #evaluate(input: string): Promise<ReplResult> {
    const nothing = { output: '', failed: false, incomplete: false, tests: [] };
    if (input.trim() === '') return nothing;
    if (this.#closed) return { ...nothing, output: 'the REPL session is closed', failed: true };
    this.#inputs++;

    // Frees the PREVIOUS input's handles; the one rendered below is still needed. Skipped while
    // the page is paused: the Runtime domain queues commands until the target resumes, so awaiting
    // this at a breakpoint hangs the input that was going to inspect it — the one thing a pause
    // exists for. The handles are freed by the next input after resuming, or by closing.
    if (!this.#frameId) {
      await this.#cdp
        .send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP })
        .catch(() => {});
    }
    // A declaration at a breakpoint would be thrown away with the evaluation that made it, so its
    // value is kept where the pause can reach it. The VALUE is still evaluated right here, which
    // is the point: `let doubled = answer * 2` has to see the frame's `answer`.
    const declared = this.#frameId ? Source.declaration(input) : null;
    if (declared) {
      this.#pausedBindings.set(declared.name, declared.blockScoped);
      // One that outlives the pause is a name this session added, and `.scope` should say when.
      // Worked out here because the usual pass is skipped while stopped.
      if (!declared.blockScoped) this.#origins.set(declared.name, `line ${this.#inputs}`);
    }
    const sources = declared
      ? [this.#inFrame(`${held(declared.name)} = ${declared.value}, undefined`, declared.name)]
      : Source.candidates(input).map((source) => this.#inFrame(source, null));
    // Raced against a pause, because the two are mutually exclusive: a `debugger` statement stops
    // the page, and `Runtime.evaluate` does not answer a stopped page. Whichever happens first is
    // the answer, and the loser is left running — the evaluation settles later, when resumed.
    const paused = new Promise<ReplResult>((resolve) => {
      this.#announcePause = resolve;
    });
    let evaluated = await Promise.race([this.#send(sources[0]), paused.then(() => PAUSED)]);
    if (evaluated === PAUSED) return await paused;
    for (let index = 1; index < sources.length; index++) {
      // Only a SYNTAX error earns a second spelling: nothing ran, so nothing can run twice.
      if (!isSyntaxError(evaluated)) break;
      evaluated = await this.#send(sources[index]);
    }

    this.#announcePause = null;
    const thrown = evaluated.exceptionDetails;
    if (thrown) {
      const description = thrown.exception?.description ?? thrown.text;
      if (isSyntaxError(evaluated) && Source.isIncomplete(description)) {
        return { ...nothing, incomplete: true };
      }

      return { ...nothing, output: resolveStack(this.#config, description), failed: true };
    }

    const rendered = await this.#render(evaluated.result);
    // Nothing can have run while the page is stopped, and asking anyway hangs: the flush resolves a
    // PROMISE, and a paused isolate never reaches the microtask that would settle it.
    const tests = this.#frameId ? [] : await this.runPending();
    // `test('…', …)` evaluates to undefined, and printing that under the TAP it just produced adds
    // nothing. Any other value still prints — the input did something besides register tests.
    const output = tests.length > 0 && rendered === 'undefined' ? '' : rendered;
    // Which input declared a name is knowable only right after that input ran, and nowhere else —
    // so it is worked out here, and only for inputs that could have declared anything. Never while
    // paused: names bound in a stopped frame belong to the frame, and `.locals` is what reads it.
    if (!this.#frameId && BINDS.test(input)) {
      for (const name of await this.names('')) {
        const introduced = !this.#baseline.has(name) && !this.#origins.has(name);
        if (introduced) this.#origins.set(name, `line ${this.#inputs}`);
      }
    }

    return { output, failed: false, incomplete: false, tests };
  }

  /**
   * An input with the breakpoint's own declarations put back in scope around it.
   *
   * They arrive as ARGUMENTS, and that is the whole trick: a parameter shadows everything outside
   * the function, including a global lexical binding, which is what a top-level `let` of the same
   * name is. Writing to `globalThis` cannot shadow one of those — declare `let me` at the prompt
   * and again at a breakpoint, and the outer one keeps winning.
   *
   * `eval` rather than a `return`, because an input is not always an expression: `if (x) { … }`
   * has no value to return, and `eval` gives a statement its completion value the same way the
   * prompt does. Being a DIRECT eval is what lets it see the frame's own locals through the
   * closure, as well as the parameters.
   *
   * Written back on the way out, so an assignment to one of them sticks. `excluding` is the name
   * being declared right now, which has no previous value to carry in or restore.
   */
  #inFrame(source: string, excluding: string | null): string {
    const names = [...this.#pausedBindings.keys()].filter((name) => name !== excluding);
    if (names.length === 0) return source;
    const restore = names.map((name) => `${held(name)} = ${name};`).join(' ');

    return `(function (${names.join(', ')}) {
      try {
        return eval(${JSON.stringify(source)});
      } finally {
        ${restore}
      }
    })(${names.map(held).join(', ')})`;
  }

  /** One `Runtime.evaluate` in REPL mode — where `let` redeclaration and top-level await work. */
  #send(expression: string): Promise<EvaluateResult> {
    // Paused: run it where the page is STOPPED, so what you type sees the locals at the breakpoint.
    // Inspecting the globals around a breakpoint would answer a question nobody asked.
    if (this.#frameId) {
      return this.#cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId: this.#frameId,
        expression,
        objectGroup: OBJECT_GROUP,
        generatePreview: true,
      }) as Promise<EvaluateResult>;
    }

    return this.#cdp.send('Runtime.evaluate', {
      expression,
      replMode: true,
      objectGroup: OBJECT_GROUP,
      generatePreview: true,
      userGesture: true,
      // Not `awaitPromise`: REPL mode ignores it, and a prompt that silently awaited every promise
      // would be answering a different question than the one that was typed. `await` works.
      awaitPromise: false,
    });
  }

  /**
   * Runs an expression for its VALUE rather than for the prompt — no REPL mode, no object group,
   * nothing rendered and nothing to release.
   *
   * Inside the paused frame when there is one. Not for what the frame can see, but because a
   * `Runtime.evaluate` against a stopped isolate never answers, and this is called from places
   * that must not be able to wedge — a keystroke among them.
   */
  async #byValue<T>(expression: string): Promise<T | []> {
    const evaluated = await (
      this.#frameId
        ? this.#cdp.send('Debugger.evaluateOnCallFrame', {
            callFrameId: this.#frameId,
            expression,
            returnByValue: true,
          })
        : this.#cdp.send('Runtime.evaluate', { expression, returnByValue: true })
    ).catch(() => null);

    return (evaluated?.result?.value as T) ?? [];
  }

  /** Renders a result: by-value primitives here, everything else by the same renderer, in the page. */
  async #render(result: RemoteObject): Promise<string> {
    if (!result.objectId || result.subtype === 'promise') return describe(result);

    const rendered = await this.#cdp.send('Runtime.callFunctionOn', {
      functionDeclaration: 'function () { return globalThis.__qunitxInspect(this); }',
      objectId: result.objectId,
      returnByValue: true,
    });

    return typeof rendered.result.value === 'string' ? rendered.result.value : describe(result);
  }

  /** Calls into the page harness — outside REPL mode, which is what makes `awaitPromise` work. */
  async #harness<T>(expression: string): Promise<T> {
    const evaluated = await this.#cdp.send('Runtime.evaluate', {
      expression: `globalThis.__qunitxHarness.${expression}`,
      awaitPromise: true,
      returnByValue: true,
      timeout: HARNESS_TIMEOUT_MS,
    });
    if (evaluated.exceptionDetails) {
      const detail =
        evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text;
      throw new Error(`qunitx repl: the page failed on ${expression} — ${detail}`);
    }

    return evaluated.result.value as T;
  }
}

// The page. Deliberately not the test-run template: `#qunit-fixture` is here because QUnit resets
// it between tests, `#qunit` because its HTML reporter renders there when you open the URL
// yourself — which is half the reason the server stays up.
/**
 * The page, with the harness inline ahead of the bundle.
 *
 * Inline rather than only `page.addInitScript`, because an init script reaches the page PLAYWRIGHT
 * drives and nothing else. `.url` invites you to open the same address in your own browser, and
 * there the bundle found no harness and died on its first line:
 *
 *     Uncaught TypeError: Cannot read properties of undefined (reading 'load')
 *
 * A page you cannot look at is half a REPL, so the harness ships with the document. The init
 * script stays as well — it is what survives a reload on the driven page — and the harness is
 * idempotent so the two cannot collide.
 */
function pageHTML(config: Config): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>qunitx repl</title>
    <link href="/node_modules/qunitx/vendor/qunit.css" rel="stylesheet">
    <script>${initScript(config)}</script>
  </head>
  <body>
    <div id="qunit"></div>
    <div id="qunit-fixture"></div>
    <script src="/tests.js"></script>
  </body>
</html>`;
}

/** The CDP shapes this file reads back — narrower than the protocol's, and only where used. */
/** One binding's slot in the holder, created on first use. */
function held(name: string): string {
  return `(${HOLDER} ??= {})[${JSON.stringify(name)}]`;
}

/**
 * Sort key for a scope listing: the order the session put things there.
 *
 * Preloaded files come first because they were there before the prompt was, then each input in the
 * order it ran — which is how the session happened, and so how it reads back.
 */
function introducedAt(where: string): number {
  const line = /^line (\d+)$/.exec(where);
  if (line) return Number(line[1]);

  return where === '' ? Number.MAX_SAFE_INTEGER : -1;
}

/** The slice of `Debugger.paused` this reads — narrower than the protocol's, and only where used. */
interface DebuggerPaused {
  callFrames: Array<{
    callFrameId: string;
    functionName?: string;
    location: { lineNumber: number; columnNumber?: number; scriptId: string };
    url?: string;
    scopeChain?: PausedScope[];
  }>;
}

/** One link of a stopped frame's scope chain, as an object whose properties can be read. */
interface PausedScope {
  type: string;
  name?: string;
  object: { objectId?: string };
}

interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
  preview?: {
    description?: string;
    overflow?: boolean;
    properties: Array<{ name: string; type: string; value?: string; subtype?: string }>;
  };
}

interface EvaluateResult {
  result: RemoteObject;
  exceptionDetails?: { text: string; exception?: RemoteObject & { className?: string } };
}

/**
 * `[Function: name]`, worked out from the source V8 hands back.
 *
 * There is no name on the wire — a `RemoteObject` for a function carries its text and nothing
 * else — so the declaration is read for one, and an arrow or an anonymous expression simply has
 * none to find.
 */
function functionLabel(source: string | undefined): string {
  const named =
    /^(?:async\s+)?(?:function\s*\*?\s*|class\s+)([\p{ID_Start}_$][\p{ID_Continue}$]*)/u.exec(
      source ?? '',
    );

  return named ? `[Function: ${named[1]}]` : '[Function (anonymous)]';
}

/** Whether an evaluation failed to parse — the one failure worth retrying with another spelling. */
function isSyntaxError(evaluated: EvaluateResult): boolean {
  return evaluated.exceptionDetails?.exception?.className === 'SyntaxError';
}

/**
 * Renders a remote object WITHOUT a round-trip, from what the protocol already sent: by-value
 * primitives, and CDP's own one-level preview for everything else.
 *
 * The in-page renderer is better and is what results go through. This is for the two places that
 * cannot have one — a console argument (a round-trip would reorder the page's output against the
 * result it belongs to) and a promise, whose settled-ness is visible only here.
 */
function describe(remote: RemoteObject): string {
  if (remote.unserializableValue) return remote.unserializableValue;
  if (!remote.objectId) return inspect(remote.value, 2, colorEnabled);
  // A function's `description` is its SOURCE, which is a scope listing's worth of text for every
  // entry. Named the way the prompt names one — the only thing anybody reads it for here.
  if (remote.type === 'function') return functionLabel(remote.description);
  if (remote.subtype === 'promise') {
    const property = (name: string) =>
      remote.preview?.properties.find((entry) => entry.name === name)?.value;
    const state = property('[[PromiseState]]') ?? 'pending';

    return state === 'pending'
      ? 'Promise { <pending> }'
      : `Promise { <${state}> ${property('[[PromiseResult]]')} }`;
  }
  const preview = remote.preview;
  if (!preview) return remote.description ?? remote.type;
  const entries = preview.properties.map((entry) => {
    // A preview gives no `value` for a function or a nested object — only its type. Printing that
    // is `{ raises: function }`, where printing the missing value is `{ raises: }`.
    const value = entry.value ?? (entry.type === 'function' ? 'ƒ' : entry.type);

    return remote.subtype === 'array' ? value : `${entry.name}: ${value}`;
  });
  const body = entries.concat(preview.overflow ? ['…'] : []).join(', ');
  if (remote.subtype === 'array') return entries.length === 0 ? '[]' : `[ ${body} ]`;
  const name = preview.description && preview.description !== 'Object' ? preview.description : '';
  const prefix = name ? `${name} ` : '';

  return entries.length === 0 ? `${prefix}{}` : `${prefix}{ ${body} }`;
}

/** Rewrites bundle frames in a stack back to the original sources, when there is a map to do it. */
function resolveStack(config: Config, stack: string): string {
  const decoder = config.state.group.sourceMapDecoder;
  if (!decoder) return stack;

  return SourceMap.resolveStack(stack, decoder, config.projectRoot).resolvedStack;
}

/**
 * The script every page load starts with: the value renderer, then the harness that pins QUnit's
 * autostart off and exposes the batch runner. An init script rather than a tag in the HTML because
 * it has to be in place before the bundle evaluates, and has to survive a reload.
 */
function initScript(config: Config): string {
  return [
    // The colour decision is made HERE and baked in: the page has no TTY, no `NO_COLOR` and no
    // idea whether anything is reading it.
    `globalThis.__qunitxInspect = (value) => (${inspect.toString()})(value, 2, ${colorEnabled});`,
    `(${harness.toString()})({ timeout: ${config.timeout} });`,
  ].join('\n');
}

/**
 * Bundles `qunitx` plus every preload file into the page's one script.
 *
 * The footer is what makes it a REPL rather than a run: instead of starting QUnit it hands the
 * namespaces to the harness, which copies their exports onto `globalThis`. That is why `test`,
 * `module` and anything a preloaded file exports can be typed at the prompt unqualified.
 */
async function bundle(config: Config, preload: string[], outDir: string): Promise<string> {
  const imports = preload.map(
    (file, i) => `import * as m${i} from '${specifier(file, config.cwd)}';`,
  );
  const modules = preload.map((file, i) => `[${JSON.stringify(relative(config, file))}, m${i}]`);
  try {
    const built = await esbuild.build({
      stdin: {
        contents: [
          `import * as qunitx from 'qunitx';`,
          ...imports,
          `globalThis.__qunitxHarness.load(qunitx, [${modules.join(', ')}]);`,
        ].join('\n'),
        resolveDir: config.cwd,
      },
      bundle: true,
      // Named but never written: `outfile` is what makes esbuild emit source-map paths relative to
      // the output directory, which is the coordinate system the frame resolver reads them in. With
      // no outfile they came out relative to the cwd, and every mapped frame gained a `tmp/` prefix.
      outfile: path.join(outDir, 'tests.js'),
      write: false,
      format: 'iife',
      logLevel: 'silent',
      keepNames: true,
      legalComments: 'none',
      sourcemap: 'inline',
      jsx: 'automatic',
      plugins: [qunitxRuntimePlugin(config.cwd), ...(config.plugins ?? [])],
    });

    return built.outputFiles[0].text;
  } catch (error) {
    throw PreloadBuildFailed(
      { detail: (error as Error)?.message ?? String(error) },
      { cause: error },
    );
  }
}

/** Path relative to the project root, for display. */
function relative(config: Config, file: string): string {
  return path.relative(config.projectRoot, file).replaceAll('\\', '/');
}

// Absolute paths read as bare specifiers inside esbuild's stdin content on Windows, so imports go
// in relative to the run's cwd.
function specifier(file: string, cwd: string): string {
  const relativePath = path.relative(cwd, file);
  const normalized = relativePath.replaceAll('\\', '/');
  if (path.isAbsolute(relativePath)) return file.replaceAll('\\', '/');

  return normalized.startsWith('.') ? normalized : `./${normalized}`;
}

/**
 * Where a pause happened, in the words a person would use for it.
 *
 * The location arrives as a script id and a zero-based line, which names nothing anyone typed. The
 * URL and a one-based line do, and match how every other location in this REPL is printed.
 */
function describeFrame(
  config: Config,
  frame: DebuggerPaused['callFrames'][number] | undefined,
  scripts: Map<string, string>,
): string {
  if (!frame) return 'debugger';
  const located = mappedLocation(config, frame, scripts);
  // Typed input belongs to no file — the same `<anonymous>` this REPL already prints in stacks.
  if (!located) return `<anonymous>:${frame.location.lineNumber + 1}`;

  const where = `${located.file}:${located.line}:${located.column}`;

  return frame.functionName ? `${frame.functionName} (${where})` : where;
}

/**
 * Where a frame is in the SOURCE, rather than in the bundle the page actually ran.
 *
 * Through the same resolver every other location goes through, by handing it a line shaped like a
 * stack frame — so a pause inside a preloaded file names that file rather than the bundle, and one
 * answer serves both what is printed and what is read off disk.
 */
function mappedLocation(
  config: Config,
  frame: DebuggerPaused['callFrames'][number],
  scripts: Map<string, string>,
): { file: string; line: number; column: number } | null {
  const { lineNumber, columnNumber, scriptId } = frame.location;
  const url = frame.url || scripts.get(scriptId);
  if (!url) return null;

  const at = `    at ${url}:${lineNumber + 1}:${(columnNumber ?? 0) + 1}`;
  const resolved = resolveStack(config, at).trim().replace(/^at /, '');
  const parsed = /^(.*):(\d+):(\d+)$/.exec(resolved);

  return parsed
    ? { file: parsed[1] as string, line: Number(parsed[2]), column: Number(parsed[3]) }
    : null;
}
