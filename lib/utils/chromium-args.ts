/**
 * Launch args passed to Chromium for both the CDP pre-launch spawn and the playwright fallback launch.
 *
 * Goal: eliminate every startup cost and background service that has no meaning in a headless
 * test context, without touching anything that affects how user test code executes.
 *
 * Anything that changes observable JS behaviour (e.g. CORS policy, storage partitioning,
 * service worker behaviour) is intentionally left at its default so user test suites behave
 * the same as they would in a real browser.
 */
export default [
  // ── Sandbox / rendering ──────────────────────────────────────────────────────
  '--no-sandbox', // required in most CI/container environments
  '--disable-gpu', // no GPU in headless; avoids GPU process startup

  // ── Window / UI ──────────────────────────────────────────────────────────────
  '--window-size=1440,900',
  '--hide-scrollbars', // no scrollbar rendering overhead

  // ── Automation markers ────────────────────────────────────────────────────────
  '--enable-automation', // sets navigator.webdriver=true; disables some UX-only overhead
  '--no-default-browser-check', // skip the OS-level "set as default" check on startup
  '--no-first-run', // skip first-run wizard

  // ── Network ───────────────────────────────────────────────────────────────────
  '--disable-background-networking',
  '--disable-sync',
  '--disable-translate',

  // ── Extensions / apps ─────────────────────────────────────────────────────────
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-component-update', // no background update checks
  '--disable-field-trial-config', // no A/B experiment config fetches at startup

  // ── Crash / diagnostics ───────────────────────────────────────────────────────
  '--disable-breakpad', // no crash reporter process spawned
  '--disable-client-side-phishing-detection', // no ML model loaded on startup
  '--metrics-recording-only',
  '--disable-hang-monitor',

  // ── Timers / scheduling ───────────────────────────────────────────────────────
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',

  // ── Memory ───────────────────────────────────────────────────────────────────
  '--disable-dev-shm-usage', // write to /tmp instead; avoids shm exhaustion with many Chromes

  // ── Navigation ───────────────────────────────────────────────────────────────
  '--disable-back-forward-cache', // no BFCache state setup; qunitx never navigates back

  // ── Audio ─────────────────────────────────────────────────────────────────────
  '--mute-audio',

  // ── Keychain / credentials ────────────────────────────────────────────────────
  '--password-store=basic', // avoids dbus/kwallet stalls on Linux
  '--use-mock-keychain', // avoids system keychain calls on macOS

  // ── Feature flags ────────────────────────────────────────────────────────────
  //
  // Only features that are invisible to user test code are disabled here.
  //
  // PaintHolding          — Chrome delays first paint by up to 500ms to prevent flash-of-
  //                         unstyled-content. Pure dead time in headless; disabling it makes
  //                         every page load return faster.
  // HttpsUpgrades         — Prevents Chrome from silently upgrading HTTP→HTTPS. Critical:
  //                         qunitx's local test server runs on HTTP; an upgrade attempt would
  //                         cause the connection to fail.
  // DestroyProfileOnBrowserClose — avoids async profile teardown on exit.
  // DialMediaRouteProvider, GlobalMediaControls, LensOverlay, MediaRouter — UI chrome with no
  //                         test relevance.
  // OptimizationHints     — background network requests for Chrome's optimization service.
  // Translate             — translation UI.
  // AvoidUnnecessaryBeforeUnloadCheckSync — reduces beforeunload handler overhead.
  '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,OptimizationHints,PaintHolding,Translate',
] as string[];
