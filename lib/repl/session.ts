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
import { harness } from './harness.ts';
import { inspect } from './inspect.ts';
import type { Browser as PlaywrightBrowser, CDPSession, Page } from 'playwright-core';
import type { HTTPServer } from '../web/index.ts';
import type { Config } from '../types.ts';
import type { TestDetails } from '../reporters/types.ts';

// Every object the page hands back is retained until it is released, and a REPL is a long
// conversation — so each evaluation frees the previous one's handles by group before making more.
const OBJECT_GROUP = 'qunitx-repl';
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
}

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
  /** Reloads the page: every binding and all page state goes, the session stays. */
  reload(): Promise<void>;
  /** Stops whatever is executing in the page — the Ctrl-C of a runaway expression. */
  interrupt(): Promise<void>;
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
    response.end(PAGE_HTML);
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
    await cdp.send('Runtime.enable');

    const session = new Session(config, { cdp, page, server, browser, url });
    session.loaded = await session.readLoaded();
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

/** The live session. A class because it owns handles and must close them exactly once. */
class Session implements ReplSession {
  url: string;
  loaded: Array<[string, string[]]> = [];
  #config: Config;
  #cdp: CDPSession;
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

  async reload(): Promise<void> {
    await this.#page.reload();
    this.loaded = await this.readLoaded();
    await this.runPending();
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

    // Frees the PREVIOUS input's handles; the one rendered below is still needed.
    await this.#cdp
      .send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP })
      .catch(() => {});
    const sources = Source.candidates(input);
    let evaluated = await this.#send(sources[0]);
    for (let index = 1; index < sources.length; index++) {
      // Only a SYNTAX error earns a second spelling: nothing ran, so nothing can run twice.
      if (!isSyntaxError(evaluated)) break;
      evaluated = await this.#send(sources[index]);
    }

    const thrown = evaluated.exceptionDetails;
    if (thrown) {
      const description = thrown.exception?.description ?? thrown.text;
      if (isSyntaxError(evaluated) && Source.isIncomplete(description)) {
        return { ...nothing, incomplete: true };
      }

      return { ...nothing, output: resolveStack(this.#config, description), failed: true };
    }

    const rendered = await this.#render(evaluated.result);
    const tests = await this.runPending();
    // `test('…', …)` evaluates to undefined, and printing that under the TAP it just produced adds
    // nothing. Any other value still prints — the input did something besides register tests.
    const output = tests.length > 0 && rendered === 'undefined' ? '' : rendered;

    return { output, failed: false, incomplete: false, tests };
  }

  /** One `Runtime.evaluate` in REPL mode — where `let` redeclaration and top-level await work. */
  #send(expression: string): Promise<EvaluateResult> {
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
      expression: `globalThis.__qunitxRepl.${expression}`,
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
const PAGE_HTML = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>qunitx repl</title>
    <link href="/node_modules/qunitx/vendor/qunit.css" rel="stylesheet">
  </head>
  <body>
    <div id="qunit"></div>
    <div id="qunit-fixture"></div>
    <script src="/tests.js"></script>
  </body>
</html>`;

/** The CDP shapes this file reads back — narrower than the protocol's, and only where used. */
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
  if (!remote.objectId) return inspect(remote.value);
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
  const entries = preview.properties.map((entry) =>
    remote.subtype === 'array' ? String(entry.value) : `${entry.name}: ${entry.value}`,
  );
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
    `globalThis.__qunitxInspect = (${inspect.toString()});`,
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
          `globalThis.__qunitxRepl.load(qunitx, [${modules.join(', ')}]);`,
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
