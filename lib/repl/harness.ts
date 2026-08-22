// The REPL's half of the page. Injected as source text (`harness.toString()`) before any page
// script runs, so — like `lib/setup/ws-client.js` and `./inspect.ts` — it must stay ONE
// self-contained function: no imports, no references to anything outside itself. Types are erased
// before it ever reaches the browser, so they are free.

/** The slice of QUnit this file drives. Type-only, so nothing here survives into the page. */
interface QUnitLike {
  version?: string;
  config: {
    autostart: boolean;
    testTimeout?: number;
    pageLoaded?: boolean;
    queue: unknown[];
    modules: unknown[];
    currentModule: Record<string, unknown>;
    pq: { finished: boolean };
  };
  on(event: string, callback: (details: Record<string, unknown>) => void): void;
  start(): void;
  reset(): void;
}

/** What the terminal calls over CDP. Type-only; the object itself is built below. */
interface ReplHarness {
  /** Called by the bundle once `qunitx` and every preloaded module has evaluated. */
  load(qunitx: Record<string, unknown>, modules: Array<[string, Record<string, unknown>]>): void;
  /** `[file, exported names]` for each preloaded module — what the banner lists. */
  loaded: Array<[string, string[]]>;
  /** Runs the tests registered since the last flush; `null` when none are waiting. */
  flush(): Promise<string | null>;
}

/**
 * Installs `globalThis.__qunitxRepl` and the QUnit preconfig that keeps the page from starting a
 * run on its own.
 *
 * Two things make a REPL out of a page that is otherwise a test run. First `autostart: false`,
 * merged by QUnit's own preconfig path, so tests wait for a prompt instead of a page load. Then
 * {@link ReplHarness.flush}, which runs whatever has been registered and — the part QUnit does not
 * offer — puts the queue back in a state that accepts the NEXT batch, so a session is many runs
 * rather than one.
 *
 * ```ts
 * import { harness } from './harness.ts';
 *
 * // Defined, not invoked: it installs page globals and only makes sense inside a browser.
 * function inject(page: { addInitScript(script: { content: string }): Promise<void> }) {
 *   return page.addInitScript({ content: `(${harness.toString()})({ timeout: 20000 })` });
 * }
 * ```
 */
export function harness(options: { timeout: number }): void {
  const target = globalThis as unknown as Record<string, unknown>;
  // QUnit merges a pre-existing `window.QUnit.config` when it loads (that is how `--filter` is
  // pinned for a normal run) and its load handler only fills in what is undefined — so `false`
  // set here survives and nothing runs until `flush()` says so.
  target.QUnit = { config: { autostart: false } };

  let collected: unknown[] = [];
  let settle: ((payload: string) => void) | null = null;

  const api: ReplHarness = {
    loaded: [],
    load(qunitx, modules) {
      assign(qunitx);
      for (const [file, namespace] of modules) {
        api.loaded.push([file, Object.keys(namespace).filter((name) => name !== 'default')]);
        assign(namespace);
      }
      const QUnit = target.QUnit as QUnitLike;
      QUnit.config.testTimeout = options.timeout;
      // Snapshotted HERE, not at `runEnd`: QUnit calls `slimAssertions()` on the line after it
      // emits `testEnd`, deleting `actual` and `expected` from every assertion to keep a long
      // suite from retaining them. Holding the live object and serializing later reported every
      // failure with `actual: null`.
      QUnit.on('testEnd', (details) =>
        collected.push(JSON.parse(JSON.stringify(details, circularReplacer()))),
      );
      QUnit.on('runEnd', () => {
        const payload = JSON.stringify({ tests: collected });
        collected = [];
        prepare(QUnit);
        const resolve = settle;
        settle = null;
        // Deferred a turn: QUnit is mid-emit, and resolving here would let the next evaluation
        // register a test into a queue that is still unwinding the run this one ended.
        if (resolve) setTimeout(() => resolve(payload), 0);
      });
    },
    flush() {
      const QUnit = target.QUnit as QUnitLike;
      if (!QUnit || !QUnit.version || QUnit.config.queue.length === 0) return Promise.resolve(null);

      return new Promise((resolve) => {
        settle = resolve;
        QUnit.start();
      });
    },
  };
  target.__qunitxRepl = api;

  function assign(namespace: Record<string, unknown>): void {
    for (const name of Object.keys(namespace)) {
      if (name !== 'default') target[name] = namespace[name];
    }
  }

  // Puts a finished QUnit back into a state that accepts new tests. `QUnit.reset()` does most of
  // it, but leaves three things a second run trips over: `pq.finished` (it clears the field on the
  // class, not on the live queue), `pageLoaded` and friends (deleted, which makes `start()` defer
  // forever), and the root module (already run, and its hooks are consumed). The fresh root keeps
  // the previous suite report so `reset()` has something to clear next time.
  function prepare(QUnit: QUnitLike): void {
    const previousRoot = QUnit.config.currentModule;
    QUnit.reset();
    QUnit.config.pq.finished = false;
    Object.assign(QUnit.config, {
      pageLoaded: true,
      started: 0,
      updateRate: 1000,
      filter: '',
      depth: 0,
      testTimeout: options.timeout,
    });
    const root = {
      name: '',
      tests: [],
      childModules: [],
      testsRun: 0,
      testsIgnored: 0,
      hooks: { before: [], beforeEach: [], afterEach: [], after: [] },
      suiteReport: previousRoot.suiteReport,
    };
    QUnit.config.currentModule = root;
    QUnit.config.modules.length = 0;
    QUnit.config.modules.push(root);
  }

  // QUnit's failure payloads carry live objects (`actual`, `expected`) that routinely point back
  // at themselves; the test-run runtime serializes them the same way.
  function circularReplacer(): (key: string, value: unknown) => unknown {
    const ancestors: unknown[] = [];

    return function (this: unknown, _key: string, value: unknown) {
      if (typeof value !== 'object' || value === null) return value;
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.indexOf(value) !== -1) return '[Circular]';
      ancestors.push(value);

      return value;
    };
  }
}
