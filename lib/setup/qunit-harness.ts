// The page-side half of running QUnit on demand, shared by the REPL and by `qunitx run` when the
// file it was given turns out to declare tests. Injected as source text (`harness.toString()`), so
// — like `lib/setup/ws-client.js` and `lib/repl/inspect.ts` — it must stay ONE self-contained
// function: no imports, no references to anything outside itself. Types are erased before it ever
// reaches the browser, so they are free.

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
  /**
   * Called by the REPL's bundle once `qunitx` and every preloaded module has evaluated, to put
   * their exports on `globalThis`. `qunitx run` has no such bundle and does not call it — which is
   * why {@link ReplHarness.flush} attaches to QUnit itself rather than relying on this.
   */
  load(
    qunitx: Record<string, unknown>,
    modules: Array<[string, string, Record<string, unknown>]>,
  ): void;
  /**
   * Puts a module in scope: its exports under their own names, and the module itself under `as`.
   *
   * The namespace is what makes one line at the prompt print everything a file has. `as` is skipped
   * where the page already has that name and this session did not put it there — a name worked out
   * from a path should not take one that already means something — unless `force` says the person
   * asked for it by hand, which is theirs to overwrite.
   *
   * A file brought in twice replaces what it brought the first time, so `.imported` says what is
   * in scope now rather than everything that ever was.
   */
  bring(file: string, as: string, namespace: Record<string, unknown>, force: boolean): string[];
  /**
   * Puts exactly these names in scope, from this file — what an `import` statement typed at the
   * prompt binds, and what a file that is not code is worth.
   *
   * Merged into what the file already brought rather than replacing it: two `import` statements
   * naming the same file are two requests, and the second is not a correction of the first.
   */
  bind(file: string, values: Record<string, unknown>): string[];
  /** `[file, exported names]` for each module in scope — what the banner lists. */
  loaded: Array<[string, string[]]>;
  /** What `qunitx` exports in this page, so a later bundle can borrow them instead of its own. */
  qunitx: string[];
  /** Runs the tests registered since the last flush; `null` when none are waiting. */
  flush(): Promise<string | null>;
}

/**
 * Installs `globalThis.__qunitxHarness`: run the tests this page has registered, on command, and be
 * ready for more.
 *
 * Two things a page that is otherwise a test run does not do. First `autostart: false`, merged by
 * QUnit's own preconfig path, so tests wait to be asked instead of running on page load. Then
 * {@link ReplHarness.flush}, which runs whatever has been registered and — the part QUnit does not
 * offer — puts the queue back in a state that accepts the NEXT batch, so a session is many runs
 * rather than one.
 *
 * Both callers want the second; only the REPL needs the first. `qunitx run` injects this AFTER its
 * bundle has evaluated, where the real QUnit already exists and the preconfig would overwrite it —
 * hence the guard — and its tests are already sitting in the queue because the qunitx runtime
 * turns `autostart` off itself.
 *
 * ```ts
 * import { harness } from './qunit-harness.ts';
 *
 * // Defined, not invoked: it installs page globals and only makes sense inside a browser.
 * function inject(page: { addInitScript(script: { content: string }): Promise<void> }) {
 *   return page.addInitScript({ content: `(${harness.toString()})({ timeout: 20000 })` });
 * }
 * ```
 */
export function harness(options: { timeout: number }): void {
  const target = globalThis as unknown as Record<string, unknown>;
  // Installed once per page, whichever route got here first. The REPL serves this inline in its
  // HTML — so a human who opens the URL gets a working page — AND as an init script, so it is in
  // place before the bundle on every reload of the driven one. Running twice would replace a
  // harness the bundle had already called `load` on, losing its hooks and its `loaded` list.
  if (target.__qunitxHarness) return;

  const existing = target.QUnit as QUnitLike | undefined;
  // QUnit merges a pre-existing `window.QUnit.config` when it loads (that is how `--filter` is
  // pinned for a normal run) and its load handler only fills in what is undefined — so `false`
  // set here survives and nothing runs until `flush()` says so.
  //
  // Only when QUnit has not loaded yet. `version` is what tells the real thing from a preconfig
  // stub, and overwriting the real one — which is what injecting this after the bundle would do —
  // would throw away every test already registered.
  if (!existing || !existing.version) target.QUnit = { config: { autostart: false } };

  let collected: unknown[] = [];
  let settle: ((payload: string) => void) | null = null;
  let attached = false;

  const api: ReplHarness = {
    loaded: [],
    qunitx: [],
    load(qunitx, modules) {
      // Kept because a `.import` after start-up must not bundle a second `qunitx`: two copies means
      // two QUnits, and tests registered against the one nobody flushes are tests that never run.
      target.__qunitxRuntime = qunitx;
      api.qunitx = Object.keys(qunitx);
      assign(qunitx);
      for (const [file, as, namespace] of modules) api.bring(file, as, namespace, false);
      attach(target.QUnit as QUnitLike);
    },
    bring(file, as, namespace, force) {
      const owned = new Set(api.loaded.flatMap(([, names]) => names));
      const values: Record<string, unknown> =
        force || !(as in target) || owned.has(as) ? { [as]: namespace } : {};
      for (const name of Object.keys(namespace)) {
        if (name !== 'default') values[name] = namespace[name];
      }
      // What the last import of this file left behind and this one does not bring: an export it
      // has since lost, or the name it used to go under. Left in place, they would be a scope full
      // of values from a version of the file that no longer exists.
      const already = api.loaded.findIndex(([known]) => known === file);
      if (already !== -1) {
        for (const stale of api.loaded[already][1]) {
          if (!(stale in values)) delete target[stale];
        }
        api.loaded.splice(already, 1);
      }

      return api.bind(file, values);
    },
    bind(file, values) {
      const names = Object.keys(values);
      for (const name of names) target[name] = values[name];
      const already = api.loaded.findIndex(([known]) => known === file);
      if (already === -1) api.loaded.push([file, names]);
      else {
        const kept = api.loaded[already][1].filter((known) => !names.includes(known));
        api.loaded[already] = [file, [...kept, ...names]];
      }

      return names;
    },
    flush() {
      const QUnit = target.QUnit as QUnitLike;
      if (!QUnit || !QUnit.version || QUnit.config.queue.length === 0) return Promise.resolve(null);
      // Attached here rather than in `load`, so a caller whose bundle never calls `load` — which is
      // every `qunitx run` — still gets its results. Idempotent: QUnit would fire each listener
      // once per registration, and a test reported twice is a wrong count, not a cosmetic one.
      attach(QUnit);

      return new Promise((resolve) => {
        settle = resolve;
        QUnit.start();
      });
    },
  };
  target.__qunitxHarness = api;

  // Hooks QUnit's reporting, once, for whoever gets here first — `load` for a REPL, `flush` for a
  // run whose bundle never called it. Twice would report every test twice, which is a wrong count.
  function attach(QUnit: QUnitLike): void {
    if (attached) return;
    attached = true;
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
  }

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
