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
    queue: unknown[];
    reporters: { html?: boolean };
  };
  reporters: { html: { init(QUnit: QUnitLike): HtmlReporterLike } };
  on(event: string, callback: (details: Record<string, unknown>) => void): void;
  start(): void;
  reset(): void;
}

/** The parts of QUnit's HTML reporter that have to be put back between runs. */
interface HtmlReporterLike {
  stats: { failedTests: unknown[]; defined: number; completed: number };
  hiddenTests: unknown[];
  listen: (() => void) | null;
  appendInterface(): void;
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
   * Puts a module in scope: the module itself under `as`, and — when it is the only one — its
   * exports under their own names too.
   *
   * `alone` is that second half. One preload owns the scope and spreading it is a convenience;
   * several cannot, because two files exporting one name means the last brought silently wins and
   * the other is gone. With more than one, `Task.partition` is the only way to say which.
   *
   * The namespace is what makes one line at the prompt print everything a file has. `as` is skipped
   * where the page already has that name and this session did not put it there — a name worked out
   * from a path should not take one that already means something — unless `force` says the person
   * asked for it by hand, which is theirs to overwrite.
   *
   * A file brought in twice replaces what it brought the first time, so `.imported` says what is
   * in scope now rather than everything that ever was.
   */
  bring(
    file: string,
    as: string,
    namespace: Record<string, unknown>,
    force: boolean,
    alone?: boolean,
  ): string[];
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
  //
  // `html: false` because QUnit 3's HTML reporter only lasts one run: its second `runStart` throws,
  // and the run never begins. The harness builds the reporter itself in `attach` instead, which is
  // the only way to hold the instance it has to prepare again before every run after the first.
  const ownsReporter = !existing || !existing.version;
  if (ownsReporter) target.QUnit = { config: { autostart: false, reporters: { html: false } } };

  let collected: unknown[] = [];
  let settle: ((payload: string) => void) | null = null;
  let attached = false;
  let reporter: HtmlReporterLike | null = null;
  let runs = 0;

  const api: ReplHarness = {
    loaded: [],
    qunitx: [],
    load(qunitx, modules) {
      // Kept because a `.import` after start-up must not bundle a second `qunitx`: two copies means
      // two QUnits, and tests registered against the one nobody flushes are tests that never run.
      target.__qunitxRuntime = qunitx;
      api.qunitx = Object.keys(qunitx);
      assign(qunitx);
      // `alone` when exactly one file was preloaded: its exports go into scope under their own
      // names as well as under the module's. Several files do not, because then the same name
      // means two things and whichever arrived last silently took it.
      const alone = modules.length === 1;
      for (const [file, as, namespace] of modules) api.bring(file, as, namespace, false, alone);
      attach(target.QUnit as QUnitLike);
    },
    bring(file, as, namespace, force, alone = true) {
      const owned = new Set(api.loaded.flatMap(([, names]) => names));
      const values: Record<string, unknown> =
        force || !(as in target) || owned.has(as) ? { [as]: namespace } : {};
      // A module namespace object is already frozen by the language — its exports cannot be
      // reassigned through it — so what goes into scope is the module, not a copy of it.
      if (alone) {
        for (const name of Object.keys(namespace)) {
          if (name !== 'default') values[name] = namespace[name];
        }
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
      if (reporter && runs > 0) prepareReporter(reporter);

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
    if (ownsReporter) {
      QUnit.config.reporters.html = true;
      reporter = QUnit.reporters.html.init(QUnit);
    }
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
      runs++;
      // Ready for the next evaluation: since QUnit 3, `reset()` alone gives a fresh queue, root
      // module and `_runStarted`, and keeps the rest of the config.
      QUnit.reset();
      const resolve = settle;
      settle = null;
      // Deferred a turn: QUnit is mid-emit, and resolving here would let the next evaluation
      // register a test into a queue that is still unwinding the run this one ended.
      if (resolve) setTimeout(() => resolve(payload), 0);
    });
  }

  // A fresh page for the next run, as a reload would give. Done when that run starts, not at
  // `runEnd`: the reporter writes its summary from a `runEnd` listener that fires after this one.
  // Its other listeners stay registered from the first run, so `listen` must not add them again.
  function prepareReporter(html: HtmlReporterLike): void {
    html.stats = { failedTests: [], defined: 0, completed: 0 };
    html.hiddenTests = [];
    html.listen = () => {};
    html.appendInterface();
  }

  function assign(namespace: Record<string, unknown>): void {
    for (const name of Object.keys(namespace)) {
      if (name !== 'default') target[name] = namespace[name];
    }
  }

  // QUnit's failure payloads carry live objects (`actual`, `expected`) that routinely point back
  // at themselves; the test-run runtime serializes them the same way.
  function circularReplacer(): (key: string, value: unknown) => unknown {
    const ancestors: unknown[] = [];

    return function (this: unknown, _key: string, value: unknown) {
      if (typeof value !== 'object' || value === null) return value;
      ancestors.splice(ancestors.lastIndexOf(this) + 1);
      if (ancestors.indexOf(value) !== -1) return '[Circular]';
      ancestors.push(value);

      return value;
    };
  }
}
