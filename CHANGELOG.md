# Changelog

## [0.21.1] - 2026-04-21
[`v0.21.0...v0.21.1`](https://github.com/izelnakri/qunitx-cli/compare/v0.21.0...v0.21.1)

### Bug Fixes
- Close HTTP server on SIGTERM to eliminate macOS port reclamation race — 2026-04-21 by [@izelnakri](https://github.com/izelnakri) ([`7d475dd`](https://github.com/izelnakri/qunitx-cli/commit/7d475ddfc8196dcccbecaf231a3a6e54e0cf4f09))
- Isolate port-free check from concurrent watch test — 2026-04-21 by [@izelnakri](https://github.com/izelnakri) ([`f2d1abb`](https://github.com/izelnakri/qunitx-cli/commit/f2d1abbb8b45cc78fab50c87aa8a7b839e3585bb))

## [0.21.0] - 2026-04-21
[`v0.20.0...v0.21.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.20.0...v0.21.0)

### Bug Fixes
- Make watch-rerun assertions robust to overlayfs-triggered extra runs — 2026-04-19 by [@izelnakri](https://github.com/izelnakri) ([`c5546cc`](https://github.com/izelnakri/qunitx-cli/commit/c5546cc94fa0ca07b82b3782526b5c9304bcd4bb))
- Add --in-process-gpu to prevent Chrome hanging on connectOverCDP in CI — 2026-04-20 by [@izelnakri](https://github.com/izelnakri) ([`3144aac`](https://github.com/izelnakri/qunitx-cli/commit/3144aac4156b07d9caccab4897131000390bdd38))
- Normalize backslash paths before embedding in esbuild stdin — 2026-04-20 by [@izelnakri](https://github.com/izelnakri) ([`8e4ed51`](https://github.com/izelnakri/qunitx-cli/commit/8e4ed51beb1f9073e8b598c386a997e4dee802ed))
- Use path.resolve + pathToFileURL for cross-platform path handling — 2026-04-20 by [@izelnakri](https://github.com/izelnakri) ([`db96ad7`](https://github.com/izelnakri/qunitx-cli/commit/db96ad71998e6fe4ccf0820ddc0ea3050be10cb9))
- Fall back to chromium.launch() when connectOverCDP times out — 2026-04-20 by [@izelnakri](https://github.com/izelnakri) ([`eaf2d06`](https://github.com/izelnakri/qunitx-cli/commit/eaf2d06cce51d9a58cb1fbd48f06e75d649f4ff6))
- Use path.sep and path.relative for cross-platform path ops — 2026-04-20 by [@izelnakri](https://github.com/izelnakri) ([`d11c13f`](https://github.com/izelnakri/qunitx-cli/commit/d11c13f948d60217840ba3d6eed61ecfc1e5bf52))
- Filter --disable-gpu on macOS fallback launch; fix mutateFSTree cross-platform separator — 2026-04-20 by [@izelnakri](https://github.com/izelnakri) ([`0d13686`](https://github.com/izelnakri/qunitx-cli/commit/0d136864d5f2c77f7764772959d1359c48f17557))
- Filter --disable-gpu from macOS pre-launch; fix Windows path separator and symlink write-through — 2026-04-20 by [@izelnakri](https://github.com/izelnakri) ([`200b720`](https://github.com/izelnakri/qunitx-cli/commit/200b7209339a29a1cbb164a2065be41306bd37c7))
- Update parseCliFlags unit test to expect path.join-normalized output — 2026-04-20 by [@izelnakri](https://github.com/izelnakri) ([`00e9241`](https://github.com/izelnakri/qunitx-cli/commit/00e9241d9bb4e67102d27d76a60a4bab33711b32))
- Replace --disable-gpu with --enable-unsafe-swiftshader; use --headless (old mode) — 2026-04-20 by [@izelnakri](https://github.com/izelnakri) ([`7b94beb`](https://github.com/izelnakri/qunitx-cli/commit/7b94beb9d601bdc0965457fa683cf2a086b73c94))
- Scope SwiftShader to Linux; kill Chrome process trees on Windows — 2026-04-21 by [@izelnakri](https://github.com/izelnakri) ([`079f5d3`](https://github.com/izelnakri/qunitx-cli/commit/079f5d3e45a6be5bb8fb05601677ab36851dd73d))
- Restore --headless=new in Chrome pre-launch for macOS — 2026-04-21 by [@izelnakri](https://github.com/izelnakri) ([`10900b8`](https://github.com/izelnakri/qunitx-cli/commit/10900b86d5239a288d39c70c1b57a034a67dcc19))
- Use playwright-core chromium-headless-shell on macOS instead of CHROME_BIN — 2026-04-21 by [@izelnakri](https://github.com/izelnakri) ([`3fb4bc9`](https://github.com/izelnakri/qunitx-cli/commit/3fb4bc963c56ccc16061253edd2ea929d8ccb9cd))
- Synthesize symlink write-through events on macOS via mtime polling — 2026-04-21 by [@izelnakri](https://github.com/izelnakri) ([`82e8226`](https://github.com/izelnakri/qunitx-cli/commit/82e82262965229daa0a075a3a057c1b45b9a2eee))
- Treat rename-for-write as change when file is already tracked — 2026-04-21 by [@izelnakri](https://github.com/izelnakri) ([`6d1f949`](https://github.com/izelnakri/qunitx-cli/commit/6d1f9497b71a9c1802cd3aa999a78cc94ef69d28))
- Retry fs.rm on EBUSY in custom-html watch test on Windows — 2026-04-21 by [@izelnakri](https://github.com/izelnakri) ([`980178c`](https://github.com/izelnakri/qunitx-cli/commit/980178c02396ab48e6e7239434a5f0586393d9ad))
- Replace time+_building dedup with mtime-based echo detection — 2026-04-21 by [@izelnakri](https://github.com/izelnakri) ([`d02f302`](https://github.com/izelnakri/qunitx-cli/commit/d02f302cf6323a11b8ccb104a6dcccb4d16cac4c))
- Replace maybeStart flags with Promise.all for QUnit init — 2026-04-21 by [@izelnakri](https://github.com/izelnakri) ([`fc822d4`](https://github.com/izelnakri/qunitx-cli/commit/fc822d4e1bbe1acf081a79b632a2f6caa2c33ca5))

### Documentation
- Document browser timezones & datetime mocking — 2026-04-21 by [@izelnakri](https://github.com/izelnakri) ([`f06986b`](https://github.com/izelnakri/qunitx-cli/commit/f06986b2a70ff21b7278c445affab9c3ae47abeb))

### Features
- Show file execution timings only on --debug — 2026-04-20 by [@izelnakri](https://github.com/izelnakri) ([`cc90783`](https://github.com/izelnakri/qunitx-cli/commit/cc907839096d9873550290070fa15a4d8ed95dbd))
- Initial macos+windows CI setup + timezone tests — 2026-04-20 by [@izelnakri](https://github.com/izelnakri) ([`00469b7`](https://github.com/izelnakri/qunitx-cli/commit/00469b762f5809fb6b820748a0319d3e4bebaed0))
- Respect QUNITX_BROWSER env var as browser fallback — 2026-04-21 by [@izelnakri](https://github.com/izelnakri) ([`58c2369`](https://github.com/izelnakri/qunitx-cli/commit/58c23699740b6cc238f96f93ce2e3feffac85d1b))

## [0.20.0] - 2026-04-19
[`v0.19.3...v0.20.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.19.3...v0.20.0)

### Bug Fixes
- Resolve testRaceResult from Node.js when WS signal is unreliable — 2026-04-18 by [@izelnakri](https://github.com/izelnakri) ([`a7202e0`](https://github.com/izelnakri/qunitx-cli/commit/a7202e0043434fe316d4ec0524aa0b7bf1640ec4))
- Await active rebuild before serving / to avoid stale _buildError on webkit — 2026-04-18 by [@izelnakri](https://github.com/izelnakri) ([`6fddd5b`](https://github.com/izelnakri/qunitx-cli/commit/6fddd5b23fc56fcca649d0c94e347997b8ebba74))
- Always update lastChangeMs so delayed inotify events are deduped — 2026-04-18 by [@izelnakri](https://github.com/izelnakri) ([`1d97a3f`](https://github.com/izelnakri/qunitx-cli/commit/1d97a3f835e3b7a7ade2216d00ae4d219bcb8127))
- Also dedup inotify change events while a build is running — 2026-04-18 by [@izelnakri](https://github.com/izelnakri) ([`51e7c6b`](https://github.com/izelnakri/qunitx-cli/commit/51e7c6bb86db378e28c5c3a443880b51fa63d0e2))
- Add TEST_STALL_BUFFER_MS so QUnit always wins the per-test timeout race — 2026-04-19 by [@izelnakri](https://github.com/izelnakri) ([`cca4071`](https://github.com/izelnakri/qunitx-cli/commit/cca4071384ff81d8f141ff71705278d40fb5df65))
- Guard error/no-tests HTML 'refresh' reload with !navigator.webdriver — 2026-04-19 by [@izelnakri](https://github.com/izelnakri) ([`a18f667`](https://github.com/izelnakri/qunitx-cli/commit/a18f667b8d7ebf1df0173f778d6caade2e5053a0))
- Suppress overlayfs IN_CLOSE_WRITE echoes via mtime vs last build end — 2026-04-19 by [@izelnakri](https://github.com/izelnakri) ([`610ba23`](https://github.com/izelnakri/qunitx-cli/commit/610ba23c6e353b29e0e5aba1a6eff8a4f3f64430))
- Harden Chrome dir cleanup against overlayfs lag and concurrent-test races — 2026-04-19 by [@izelnakri](https://github.com/izelnakri) ([`b24e500`](https://github.com/izelnakri/qunitx-cli/commit/b24e500bfc11d493c0e2b874616f9cb91341a773))

### Features
- Set QUnit.config.testTimeout so --timeout applies in the browser UI too — 2026-04-19 by [@izelnakri](https://github.com/izelnakri) ([`f18f57c`](https://github.com/izelnakri/qunitx-cli/commit/f18f57c0293ac830dd6862cbf9f379c5460411a2))
- Resolve bundle stack frames to original sources via inline source-map — 2026-04-19 by [@izelnakri](https://github.com/izelnakri) ([`8d8a083`](https://github.com/izelnakri/qunitx-cli/commit/8d8a0834d167d3d4590213dc0aed2eb288acc40f))

### Performance
- Parallel timings/browser start, watch-mode parallel build+navigation — 2026-04-18 by [@izelnakri](https://github.com/izelnakri) ([`6e8b132`](https://github.com/izelnakri/qunitx-cli/commit/6e8b132359ac41d8d0abb00bf5830492cbb2c9d8))
- Start browser connect at top of run() to race buildCachedContent — 2026-04-19 by [@izelnakri](https://github.com/izelnakri) ([`7e5b5aa`](https://github.com/izelnakri/qunitx-cli/commit/7e5b5aa9b56dcb73a5f4ff80e99093fb2c719a2f))

### Refactoring
- Remove dead browser-side testTimeout polling and unreachable route fallback — 2026-04-18 by [@izelnakri](https://github.com/izelnakri) ([`f6e7aa3`](https://github.com/izelnakri/qunitx-cli/commit/f6e7aa3962fba8eb3aea0cba98453c538d1281ef))
- Drop express/cors devDeps, rename expressApp to webServer — 2026-04-19 by [@izelnakri](https://github.com/izelnakri) ([`f5b20e9`](https://github.com/izelnakri/qunitx-cli/commit/f5b20e9dd98e1ca8286d8a3b73a7cd4591ea9ec6))

## [0.19.3] - 2026-04-18
[`v0.19.2...v0.19.3`](https://github.com/izelnakri/qunitx-cli/compare/v0.19.2...v0.19.3)

### Bug Fixes
- Scan /proc/$pid/fd to catch Chrome sandbox processes in cleanup — 2026-04-18 by [@izelnakri](https://github.com/izelnakri) ([`ca863de`](https://github.com/izelnakri/qunitx-cli/commit/ca863dea285f0fe6a682a5a41d30297b3e10bf85))
- Replace killAndAwait with rm()-driven retry in cleanupBrowserDir — 2026-04-18 by [@izelnakri](https://github.com/izelnakri) ([`6d2a16c`](https://github.com/izelnakri/qunitx-cli/commit/6d2a16c21b612eb6a9542eabb57b8638c951d4ee))
- Remove zombie-poll loop from sweepOrphanedChrome, shutdownPrelaunch on error — 2026-04-18 by [@izelnakri](https://github.com/izelnakri) ([`39d40ef`](https://github.com/izelnakri/qunitx-cli/commit/39d40efeb421797951ee6cdcb4962c95e287e750))
- Run bench-check before test suite for cold-system accuracy — 2026-04-18 by [@izelnakri](https://github.com/izelnakri) ([`196f951`](https://github.com/izelnakri/qunitx-cli/commit/196f9510e040949dfb67c09e91ceea0fb1ff1eb9))

### Performance
- Reduce keepAlive event-loop wake-ups by 10× in concurrent mode — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`8efe2f2`](https://github.com/izelnakri/qunitx-cli/commit/8efe2f2a9135f5615e446d4aa8905521dfd07377))
- Skip fs.stat for files with a warm timing cache in splitIntoGroups — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`2833968`](https://github.com/izelnakri/qunitx-cli/commit/28339682fce27d68abea8abe64fed4f5ad1282c6))
- Pre-compile parameterized route regexes in HTTPServer at registration time — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`ac43f4a`](https://github.com/izelnakri/qunitx-cli/commit/ac43f4aafd3d857e92a18de9345c0c5555b926fc))
- Use a single shared HTTPServer for all concurrent groups — 2026-04-18 by [@izelnakri](https://github.com/izelnakri) ([`8ae0ffb`](https://github.com/izelnakri/qunitx-cli/commit/8ae0ffb9286e7f1ced9df71999232bd78bf4348b))
- Single esbuild invocation for all concurrent group bundles — 2026-04-18 by [@izelnakri](https://github.com/izelnakri) ([`0719798`](https://github.com/izelnakri/qunitx-cli/commit/07197984d0f96938d40d469821acfa18960d7642))
- Wire buildAllGroupBundles into run.ts to activate single-esbuild optimization — 2026-04-18 by [@izelnakri](https://github.com/izelnakri) ([`f8fae94`](https://github.com/izelnakri/qunitx-cli/commit/f8fae942b329fab2aa44916fd8ad98129304f039))

### Refactoring
- Pre-cache HTML, parallel close, debug logging on swallowed errors — 2026-04-18 by [@izelnakri](https://github.com/izelnakri) ([`531b1af`](https://github.com/izelnakri/qunitx-cli/commit/531b1af4b8e7975777e24823678bd878b45c78c9))

## [0.19.2] - 2026-04-17
[`v0.19.1...v0.19.2`](https://github.com/izelnakri/qunitx-cli/compare/v0.19.1...v0.19.2)

### Bug Fixes
- Pre-serialize console args in browser to bypass BiDi handle limitation — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`2891399`](https://github.com/izelnakri/qunitx-cli/commit/2891399381e233f1b3d550681ef74b51af225c69))
- Use location.port in WS URL so runtimeScript cache is safe — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`be21519`](https://github.com/izelnakri/qunitx-cli/commit/be215193f5eb2c20230f5b8f1706de9b02fbc1ff))
- Add JSDoc to exported readTimingCache, computeFileTimes, NOT_FOUND_HTML — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`5aea265`](https://github.com/izelnakri/qunitx-cli/commit/5aea26533bf295bd295bd5628904e890d5b60109))

### Performance
- Gate HTTP fetch logs behind --debug to clean up TAP stdout — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`bf4a424`](https://github.com/izelnakri/qunitx-cli/commit/bf4a424da6803d019bd566b15eab01e3e7096672))
- Cache testRuntimeToInject result per server instance — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`61231f8`](https://github.com/izelnakri/qunitx-cli/commit/61231f8c6eb68e0949e57b1ec55322ce164d601d))
- Replace IS_PLAYWRIGHT flag with navigator.webdriver — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`ed0a03d`](https://github.com/izelnakri/qunitx-cli/commit/ed0a03dddf4b5df58caed81b527921c4ebf560f2))
- Strip assertions array from non-failing testEnd WS messages — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`6ae7a7d`](https://github.com/izelnakri/qunitx-cli/commit/6ae7a7d10b20821d233cfa4b08391c8c0de1d318))
- LPT bin-packing with historical timing cache + per-file TAP timings — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`26bdbe4`](https://github.com/izelnakri/qunitx-cli/commit/26bdbe41b5b8df19a340a505756c243c1352db14))

## [0.19.1] - 2026-04-17
[`v0.19.0...v0.19.1`](https://github.com/izelnakri/qunitx-cli/compare/v0.19.0...v0.19.1)

### Bug Fixes
- Fall back to JSON.stringify for console args that jsonValue() can't serialize — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`f9d8cf9`](https://github.com/izelnakri/qunitx-cli/commit/f9d8cf937d74ab2b13b161c099a0827bff460de9))
- Flush pending console BiDi round-trips before browser/page close — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`a4516fb`](https://github.com/izelnakri/qunitx-cli/commit/a4516fb7543a5bfbae7e1eefccbd47334fd48cb7))
- Eliminate resource-leak test flakiness on loaded CI — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`30149ab`](https://github.com/izelnakri/qunitx-cli/commit/30149ab56a9d37c34c2df1ed5925809467d1a4fa))
- Replace one-shot allSettled flush with recursive stable-empty check — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`14fc1c0`](https://github.com/izelnakri/qunitx-cli/commit/14fc1c05e7c69945f4158711138d0f0353207d71))

### Performance
- --watch faster refresh optimization shrink dedupe_ms by 20ms — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`b23bdc0`](https://github.com/izelnakri/qunitx-cli/commit/b23bdc09f978c51e194b951c2a70e66db490ab5a))
- Remove unused moduleStart WS send — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`3e5aa9e`](https://github.com/izelnakri/qunitx-cli/commit/3e5aa9e3455472592021447590962ef3a5121ccf))
- Eliminate page.evaluate() CDP round-trip via WS done message — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`485ab23`](https://github.com/izelnakri/qunitx-cli/commit/485ab230fc29cfdc6b07fa4572011f17ea06033b))
- Add Content-Length to /tests.js and /filtered-tests.js responses — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`2142808`](https://github.com/izelnakri/qunitx-cli/commit/2142808c5ca913d23293b194da8d37016d312942))
- Cache ancestorNodeModules(process.cwd()) at module level — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`f028ea2`](https://github.com/izelnakri/qunitx-cli/commit/f028ea21fe49c22a18be67323d1f9ce682f98d21))
- LPT bin-packing for concurrent group formation — 2026-04-17 by [@izelnakri](https://github.com/izelnakri) ([`8ab4bd3`](https://github.com/izelnakri/qunitx-cli/commit/8ab4bd3a38d979b5fe58d3c2b6699c5540d57a2a))

## [0.19.0] - 2026-04-16
[`v0.18.0...v0.19.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.18.0...v0.19.0)

### Bug Fixes
- Auto-navigate Playwright page to error HTML on build error; fix doubled-path in file watcher — 2026-04-16 by [@izelnakri](https://github.com/izelnakri) ([`9da9ed0`](https://github.com/izelnakri/qunitx-cli/commit/9da9ed036b90bb7f63f3665a307adc61714a83a1))
- Poll HTTP endpoint for error HTML to avoid _buildError null-window race — 2026-04-16 by [@izelnakri](https://github.com/izelnakri) ([`fec3506`](https://github.com/izelnakri/qunitx-cli/commit/fec3506ff4feceffeb8956170e7d0a32006cdda8))
- Preserve absolute paths that are outside the project root — 2026-04-16 by [@izelnakri](https://github.com/izelnakri) ([`a26d8e8`](https://github.com/izelnakri/qunitx-cli/commit/a26d8e818f65e8da409347568591d456687a28a1))
- Suppress esbuild error output to stdout; ensure tmp/ exists before writing syntax-error fixtures — 2026-04-16 by [@izelnakri](https://github.com/izelnakri) ([`9bbc882`](https://github.com/izelnakri/qunitx-cli/commit/9bbc882c5487597f63f755437e7e1eddd30823b0))
- Prevent crash on initial build error; skip second browser open in headed watch mode — 2026-04-16 by [@izelnakri](https://github.com/izelnakri) ([`1ca15f7`](https://github.com/izelnakri/qunitx-cli/commit/1ca15f7108ad591a7e55255c667441bcb9e503e4))
- Reuse existing tab in headed watch mode to avoid duplicate blank tab — 2026-04-16 by [@izelnakri](https://github.com/izelnakri) ([`7ff9763`](https://github.com/izelnakri/qunitx-cli/commit/7ff976398ffb76eff621f885dba557945f5c4879))
- Suppress false-positive overlayfs warning for legitimately small bundles — 2026-04-16 by [@izelnakri](https://github.com/izelnakri) ([`64ed621`](https://github.com/izelnakri/qunitx-cli/commit/64ed621cda5ead6a71dc7c9cb6bbc0155667f126))
- Resolve packages for out-of-root test files — 2026-04-16 by [@izelnakri](https://github.com/izelnakri) ([`a5573e3`](https://github.com/izelnakri/qunitx-cli/commit/a5573e34c407e2e6a6aff2a81615ac71a02853ef))
- Guard against undefined display path for out-of-root files; reformat ancestorNodeModules — 2026-04-16 by [@izelnakri](https://github.com/izelnakri) ([`95a332c`](https://github.com/izelnakri/qunitx-cli/commit/95a332cef644cd7d6d6d6591eb2fb155d2868b46))

### Features
- Add # todo: x to TAPDisplayFinalResult() — 2026-04-15 by [@izelnakri](https://github.com/izelnakri) ([`755511e`](https://github.com/izelnakri/qunitx-cli/commit/755511edb26b5e46c7af2e9b2f69a2d14f158d5b))
- Warn on 0 registered QUnit tests instead of timing out — 2026-04-16 by [@izelnakri](https://github.com/izelnakri) ([`53cd3f1`](https://github.com/izelnakri/qunitx-cli/commit/53cd3f1c3aed6039809aa8d7e8fe1e3b276fa0bb))

## [0.18.0] - 2026-04-14
[`v0.17.8...v0.18.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.17.8...v0.18.0)

### Bug Fixes
- Scope Chrome dir leak check to dirs created by this test's run — 2026-04-14 by [@izelnakri](https://github.com/izelnakri) ([`edc0c2f`](https://github.com/izelnakri/qunitx-cli/commit/edc0c2fbc6811cd143d720402f1337e399ef7d66))
- Wait for child exit after SIGKILL before releasing semaphore permit — 2026-04-14 by [@izelnakri](https://github.com/izelnakri) ([`eddcde1`](https://github.com/izelnakri/qunitx-cli/commit/eddcde170df6816bba6cde7ace88e5d584bc105e))

### Features
- Overhaul TAP output — stream via process.stdout.write, fix serialization, add unit tests — 2026-04-14 by [@izelnakri](https://github.com/izelnakri) ([`b3c6234`](https://github.com/izelnakri/qunitx-cli/commit/b3c6234ed5216ea345b1e01f7b02278e79f968ff))

## [0.17.8] - 2026-04-14
[`v0.17.7...v0.17.8`](https://github.com/izelnakri/qunitx-cli/compare/v0.17.7...v0.17.8)

### Bug Fixes
- Treat pageerror as hard failure by incrementing failCount — 2026-04-14 by [@izelnakri](https://github.com/izelnakri) ([`cadff59`](https://github.com/izelnakri/qunitx-cli/commit/cadff59aaaf6e0f06efa724b9cafdae75950dedc))
- Detect child exit early in withRunningServer, widen port retry budget — 2026-04-14 by [@izelnakri](https://github.com/izelnakri) ([`a64857b`](https://github.com/izelnakri/qunitx-cli/commit/a64857b9653269d4cf2b4fe9708d71cd7937a9a7))
- Always clear _preBuildPromise on first runTestsInBrowser entry — 2026-04-14 by [@izelnakri](https://github.com/izelnakri) ([`d35f80d`](https://github.com/izelnakri/qunitx-cli/commit/d35f80dfa41e0fd830b3d40d02ab0fe10c330925))
- Increase browser-compat timeout to 30m to break webkit cache bootstrap deadlock — 2026-04-14 by [@izelnakri](https://github.com/izelnakri) ([`92ec6dc`](https://github.com/izelnakri/qunitx-cli/commit/92ec6dcb46c121b2769d369bcd118e0a5134415b))
- Overhaul regression checker for stable make release — 2026-04-14 by [@izelnakri](https://github.com/izelnakri) ([`bd57740`](https://github.com/izelnakri/qunitx-cli/commit/bd577405516c0478076e466ecd3891a1bd5b9a7a))

### Features
- Esbuild incremental context for ~2.3x faster watch-mode rebuilds — 2026-04-14 by [@izelnakri](https://github.com/izelnakri) ([`8e0af33`](https://github.com/izelnakri/qunitx-cli/commit/8e0af336f5641a71bf65b85098d79de264c5a6f5))
- Add assert.timeout() e2e tests, upgrade qunitx to 1.2.7 — 2026-04-14 by [@izelnakri](https://github.com/izelnakri) ([`028a89f`](https://github.com/izelnakri/qunitx-cli/commit/028a89ffe25816bab37fc149b0ff684ef23c50dd))

## [0.17.7] - 2026-04-13
[`v0.17.6...v0.17.7`](https://github.com/izelnakri/qunitx-cli/compare/v0.17.6...v0.17.7)

### Bug Fixes
- Poll killedPids in rm() catch instead of pre-polling, matching pre-launch-chrome pattern — 2026-04-13 by [@izelnakri](https://github.com/izelnakri) ([`9dc0b2c`](https://github.com/izelnakri/qunitx-cli/commit/9dc0b2cb976e8611cd16b8b285fdecf1deb5bd3a))

## [0.17.6] - 2026-04-13
[`v0.17.5...v0.17.6`](https://github.com/izelnakri/qunitx-cli/compare/v0.17.5...v0.17.6)

### Bug Fixes
- Publish before commit so release tag contains clean lockfile — 2026-04-13 by [@izelnakri](https://github.com/izelnakri) ([`6dbf85a`](https://github.com/izelnakri/qunitx-cli/commit/6dbf85a9b5674fae81a6304396f086cae9ffba2f))
- Poll /proc until killed Chrome PIDs exit before rmdir in sweep — 2026-04-13 by [@izelnakri](https://github.com/izelnakri) ([`1785ed8`](https://github.com/izelnakri/qunitx-cli/commit/1785ed8481f7c72e8b5e1abba94dfc1857643ccb))
- Retry rm() after process group exits to avoid EBUSY on user-data dir — 2026-04-13 by [@izelnakri](https://github.com/izelnakri) ([`4c63808`](https://github.com/izelnakri/qunitx-cli/commit/4c63808c4ff062fb72c0678d35f603398b7e6983))

## [0.17.5] - 2026-04-13
[`v0.17.4...v0.17.5`](https://github.com/izelnakri/qunitx-cli/compare/v0.17.4...v0.17.5)

### Bug Fixes
- Kill Chrome process groups and prevent resource leaks — 2026-04-13 by [@izelnakri](https://github.com/izelnakri) ([`f1a3c28`](https://github.com/izelnakri/qunitx-cli/commit/f1a3c28bef508b54462f0efbe99b6700cc8ad37b))

## [0.17.3] - 2026-04-13
[`v0.17.2...v0.17.3`](https://github.com/izelnakri/qunitx-cli/compare/v0.17.2...v0.17.3)

### Bug Fixes
- Skip outdated optional SEA binary and lint bin/ directory — 2026-04-13 by [@izelnakri](https://github.com/izelnakri) ([`7b0aa91`](https://github.com/izelnakri/qunitx-cli/commit/7b0aa9176e3f65414b2dbd418ffb5f600ea96846))
- Widen semaphore grant timeout from 200ms to 2000ms to avoid flake under load — 2026-04-13 by [@izelnakri](https://github.com/izelnakri) ([`80404ed`](https://github.com/izelnakri/qunitx-cli/commit/80404edc3945d22ea8c0e035a5b54c7c74e7208c))

## [0.17.2] - 2026-04-12
[`v0.17.1...v0.17.2`](https://github.com/izelnakri/qunitx-cli/compare/v0.17.1...v0.17.2)

### Bug Fixes
- Prevent two flaky test failures — 2026-04-12 by [@izelnakri](https://github.com/izelnakri) ([`7021d81`](https://github.com/izelnakri/qunitx-cli/commit/7021d81e4f7699bf248503e678ca7b626d58f979))

### Documentation
- Significantly improve docs — 2026-04-12 by [@izelnakri](https://github.com/izelnakri) ([`6c74d73`](https://github.com/izelnakri/qunitx-cli/commit/6c74d738a37d7deaedaa8c5e8744f1128c13488d))

### Features
- Smarter $ qunitx generate command — 2026-04-12 by [@izelnakri](https://github.com/izelnakri) ([`57d147b`](https://github.com/izelnakri/qunitx-cli/commit/57d147b41577ee8053f555a418d9d3b418a9a00c))

## [0.17.1] - 2026-04-12
[`v0.17.0...v0.17.1`](https://github.com/izelnakri/qunitx-cli/compare/v0.17.0...v0.17.1)

### Bug Fixes
- Relax simultaneous-writes assertion to tolerate split runs — 2026-04-12 by [@izelnakri](https://github.com/izelnakri) ([`597589f`](https://github.com/izelnakri/qunitx-cli/commit/597589fac192fac91e1ee31dab62964bf122f777))

## [0.17.0] - 2026-04-12
[`v0.16.0...v0.17.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.16.0...v0.17.0)

### Bug Fixes
- Force-exit runner, skip semaphore for non-browser commands, label bench-check silence — 2026-04-12 by [@izelnakri](https://github.com/izelnakri) ([`6a63a9e`](https://github.com/izelnakri/qunitx-cli/commit/6a63a9e6f5adb9a3ac5240bfdc31f55ca042ac85))

## [0.16.0] - 2026-04-12
[`v0.15.0...v0.16.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.15.0...v0.16.0)

### Bug Fixes
- Repair five file-watcher correctness bugs and expand test coverage — 2026-04-11 by [@izelnakri](https://github.com/izelnakri) ([`a27bb65`](https://github.com/izelnakri/qunitx-cli/commit/a27bb656856b6bc9d2bf78a8e4e7a2f8772a34dd))

### Features
- TCP semaphore concurrency, esbuild memory-first, expanded Chromium args — 2026-04-12 by [@izelnakri](https://github.com/izelnakri) ([`a715412`](https://github.com/izelnakri/qunitx-cli/commit/a715412257faedde56afdc5120c99c9073c8d231))

### Refactoring
- Simplify file-watcher and related tests — 2026-04-11 by [@izelnakri](https://github.com/izelnakri) ([`4c1bab6`](https://github.com/izelnakri/qunitx-cli/commit/4c1bab6f2273512891a86b67614fb7c3a5d238e9))

## [0.12.0] - 2026-04-11
[`v0.11.0...v0.12.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.11.0...v0.12.0)

### Bug Fixes
- Improve dev/CI debugging and test isolation — 2026-04-11 by [@izelnakri](https://github.com/izelnakri) ([`6718976`](https://github.com/izelnakri/qunitx-cli/commit/67189762bee77d1b0642936f08a587eb49e17e69))
- Stream logs directly instead of piping through tee — 2026-04-11 by [@izelnakri](https://github.com/izelnakri) ([`b96d673`](https://github.com/izelnakri/qunitx-cli/commit/b96d6733f901f7eae132689da0bdf4ac57a78b09))
- Ignore spurious change events for newly added files — 2026-04-11 by [@izelnakri](https://github.com/izelnakri) ([`6315440`](https://github.com/izelnakri/qunitx-cli/commit/63154408743e26a75bd18244348cb901a47c26a1))
- Wait for child process exit instead of fixed delay in port-test — 2026-04-11 by [@izelnakri](https://github.com/izelnakri) ([`382b975`](https://github.com/izelnakri/qunitx-cli/commit/382b975794409f4e47253fe210181ab7875b23c6))

### Features
- Improve CI/local debugging with phase tracking and debug output — 2026-04-11 by [@izelnakri](https://github.com/izelnakri) ([`a77498f`](https://github.com/izelnakri/qunitx-cli/commit/a77498fef476a75fd85d9694727e361c9fbffc17))

### Performance
- Enable within-module concurrency for safe tests and drop redundant --test-concurrency flag — 2026-04-11 by [@izelnakri](https://github.com/izelnakri) ([`3d0554b`](https://github.com/izelnakri/qunitx-cli/commit/3d0554bb9e633527718cf2c89d503c7caa80a6df))
- Tighten regression gate with magnitude-aware thresholds — 2026-04-11 by [@izelnakri](https://github.com/izelnakri) ([`552d25e`](https://github.com/izelnakri/qunitx-cli/commit/552d25ebdb3fba40520193658072a1818e4c739d))

## [0.11.0] - 2026-04-11
[`v0.10.0...v0.11.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.10.0...v0.11.0)

### Bug Fixes
- Kill chrome zombie processes on CI and add better debug prints — 2026-04-11 by [@izelnakri](https://github.com/izelnakri) ([`61b2af6`](https://github.com/izelnakri/qunitx-cli/commit/61b2af658ef4b1a764462220791cab1a93ca5b17))
- Prevent 110-byte empty bundle from overlayfs IN_DELETE race on CI — 2026-04-11 by [@izelnakri](https://github.com/izelnakri) ([`3befe68`](https://github.com/izelnakri/qunitx-cli/commit/3befe6882b9edf13911e922e419b5e071a92dcc8))
- Retry esbuild when bundle is too small due to overlayfs content lag — 2026-04-11 by [@izelnakri](https://github.com/izelnakri) ([`8ccf4c2`](https://github.com/izelnakri/qunitx-cli/commit/8ccf4c279a443f3c16f05b55de5f1ec395cb07ce))

## [0.10.0] - 2026-04-10
[`v0.9.10...v0.10.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.9.10...v0.10.0)

### Bug Fixes
- Ignore spurious inotify stat failures and cache mainHTML asset replacement — 2026-04-08 by [@izelnakri](https://github.com/izelnakri) ([`49fcba4`](https://github.com/izelnakri/qunitx-cli/commit/49fcba425fd2ad1a8425bace282ce6b667eee0b1))
- Important changes to --open and port assignments — 2026-04-09 by [@izelnakri](https://github.com/izelnakri) ([`34d09af`](https://github.com/izelnakri/qunitx-cli/commit/34d09af34f2d2bd8b58b895117cda51124f510a8))
- --open=echo works for tests — 2026-04-09 by [@izelnakri](https://github.com/izelnakri) ([`3637378`](https://github.com/izelnakri/qunitx-cli/commit/3637378e9d9ce02593fa53b92e15dab20453e60b))
- Handle browser sighup & sigterm better for more stable tests — 2026-04-09 by [@izelnakri](https://github.com/izelnakri) ([`9bcb454`](https://github.com/izelnakri/qunitx-cli/commit/9bcb45459086b70c2910673ea20685bc69694bc7))
- Use domcontentloaded instead of load for page navigation — 2026-04-10 by [@izelnakri](https://github.com/izelnakri) ([`56e6510`](https://github.com/izelnakri/qunitx-cli/commit/56e65104b5577a1e131081f173470d5d2635e41c))
- Various watcher test stablization & small test run fix — 2026-04-10 by [@izelnakri](https://github.com/izelnakri) ([`be629e8`](https://github.com/izelnakri/qunitx-cli/commit/be629e80e67c9d5fbc2a1f8da7263fd7d5a207ee))

### Features
- Support dynamic custom HTML templates and stabilize watch reruns — 2026-04-08 by [@izelnakri](https://github.com/izelnakri) ([`4ccbd01`](https://github.com/izelnakri/qunitx-cli/commit/4ccbd01caa25c044049add42adac0b082ca1fc73))
- Add --version flag and wire watch-rerun tests — 2026-04-08 by [@izelnakri](https://github.com/izelnakri) ([`83a9207`](https://github.com/izelnakri/qunitx-cli/commit/83a9207e38389462041c2bfd752b063cc4f421d1))
- Add --open flag, warn on unknown flags, and harden file watcher — 2026-04-09 by [@izelnakri](https://github.com/izelnakri) ([`4cc29e7`](https://github.com/izelnakri/qunitx-cli/commit/4cc29e7bb2a2bc2f5f0a545c10beb005be2706cf))
- Qunitx port start from 1234 and auto-increment now for DX — 2026-04-09 by [@izelnakri](https://github.com/izelnakri) ([`7a3be1e`](https://github.com/izelnakri/qunitx-cli/commit/7a3be1e619d0bece277122324fcc9dfc3a1dc437))
- --open flag now accepts binary references — 2026-04-09 by [@izelnakri](https://github.com/izelnakri) ([`c2a0bfc`](https://github.com/izelnakri/qunitx-cli/commit/c2a0bfc6180a428eb2eaf9708dd9a9ba3fe09067))
- Rename {{content}} to {{qunitxScript}} for test HTMLs — 2026-04-10 by [@izelnakri](https://github.com/izelnakri) ([`7bfa520`](https://github.com/izelnakri/qunitx-cli/commit/7bfa52054fe06dad36fa5cadc535a232ca400f9c))
- MAJOR runtime CPU-time optimization JS/HTML runtime bundle processing — 2026-04-10 by [@izelnakri](https://github.com/izelnakri) ([`67fa9e6`](https://github.com/izelnakri/qunitx-cli/commit/67fa9e6d54d1e051908bd53f44d3b44b8d9451b4))

### Performance
- Use linked sourcemap in watch mode to shrink inlined bundle 3x — 2026-04-09 by [@izelnakri](https://github.com/izelnakri) ([`3c0710a`](https://github.com/izelnakri/qunitx-cli/commit/3c0710ab01afdc75a012072366ec67e8dcfa215c))

### Refactoring
- Refactor findFreePort() test util — 2026-04-10 by [@izelnakri](https://github.com/izelnakri) ([`935047b`](https://github.com/izelnakri/qunitx-cli/commit/935047bb4f7b51688c68e85183ead68fdd6d6128))

## [0.9.10] - 2026-03-31
[`v0.9.9...v0.9.10`](https://github.com/izelnakri/qunitx-cli/compare/v0.9.9...v0.9.10)

### Features
- Qunitx binary runs when there is no html! — 2026-03-31 by [@izelnakri](https://github.com/izelnakri) ([`84ca12a`](https://github.com/izelnakri/qunitx-cli/commit/84ca12ae6177338aa3428a3fba46067adf6b18f4))

## [0.9.9] - 2026-03-30
[`v0.9.8...v0.9.9`](https://github.com/izelnakri/qunitx-cli/compare/v0.9.8...v0.9.9)

### Bug Fixes
- Now SEA has playwright dep explicity stated to fix the resolve bug — 2026-03-30 by [@izelnakri](https://github.com/izelnakri) ([`884138a`](https://github.com/izelnakri/qunitx-cli/commit/884138aa41c4ff90805e5f06a0857932a8640377))

## [0.9.8] - 2026-03-30
[`v0.9.7...v0.9.8`](https://github.com/izelnakri/qunitx-cli/compare/v0.9.7...v0.9.8)

### Bug Fixes
- Clear further warnings on make release for SEA — 2026-03-30 by [@izelnakri](https://github.com/izelnakri) ([`b69383b`](https://github.com/izelnakri/qunitx-cli/commit/b69383b59ffed2b51fe082dd4ca8506e5afbc8a3))

## [0.9.7] - 2026-03-30
[`v0.9.6...v0.9.7`](https://github.com/izelnakri/qunitx-cli/compare/v0.9.6...v0.9.7)

### Features
- Fix make release for SEA further — 2026-03-30 by [@izelnakri](https://github.com/izelnakri) ([`af4993c`](https://github.com/izelnakri/qunitx-cli/commit/af4993c657c1246feb61d899f14c4d2e85d289e7))

## [0.9.6] - 2026-03-30
[`v0.9.4...v0.9.6`](https://github.com/izelnakri/qunitx-cli/compare/v0.9.4...v0.9.6)

### Features
- Upgrade typescript to v6 — 2026-03-29 by [@izelnakri](https://github.com/izelnakri) ([`6739ed5`](https://github.com/izelnakri/qunitx-cli/commit/6739ed5e3179eb9daa3f81b83fb75347745249e0))
- Qunitx-cli now SEA(Single Executable Application) — 2026-03-30 by [@izelnakri](https://github.com/izelnakri) ([`0f11fbd`](https://github.com/izelnakri/qunitx-cli/commit/0f11fbdb31be29fdbc82a9354229befe407ee1f3))

## [0.9.4] - 2026-03-29
[`v0.9.3...v0.9.4`](https://github.com/izelnakri/qunitx-cli/compare/v0.9.3...v0.9.4)

### Features
- Remove "picomatch" dependency — 2026-03-29 by [@izelnakri](https://github.com/izelnakri) ([`952b33b`](https://github.com/izelnakri/qunitx-cli/commit/952b33bf16842a336768033fcb5ed2d963f91afd))

## [0.9.3] - 2026-03-29
[`v0.9.2...v0.9.3`](https://github.com/izelnakri/qunitx-cli/compare/v0.9.2...v0.9.3)

### Features
- Moved entire project to TypeScript — 2026-03-27 by [@izelnakri](https://github.com/izelnakri) ([`eaf09ab`](https://github.com/izelnakri/qunitx-cli/commit/eaf09ab0beb13e6c96f76b5bed76c015611ff2aa))

### Refactoring
- Custom-asserts output for readability — 2026-03-29 by [@izelnakri](https://github.com/izelnakri) ([`be2f61d`](https://github.com/izelnakri/qunitx-cli/commit/be2f61d3e83b14ac9c9cdf3310507476d0a87ab9))

## [0.9.2] - 2026-03-26
[`v0.9.1...v0.9.2`](https://github.com/izelnakri/qunitx-cli/compare/v0.9.1...v0.9.2)

### Features
- Small refactors & cleanups before release — 2026-03-24 by [@izelnakri](https://github.com/izelnakri) ([`cee5cd2`](https://github.com/izelnakri/qunitx-cli/commit/cee5cd25dd989e898c029d46d60e5de115d3e1d2))

### Refactoring
- MAJOR TEST SUITE REFACTOR — 2026-03-19 by [@izelnakri](https://github.com/izelnakri) ([`518bd64`](https://github.com/izelnakri/qunitx-cli/commit/518bd64ab2d467fb958b45d5da0cf4fe94044b21))

## [0.9.0] - 2026-03-19
[`v0.8.0...v0.9.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.8.0...v0.9.0)

### Bug Fixes
- Resolve deno doc lint errors on exported consts — 2026-03-19 by [@izelnakri](https://github.com/izelnakri) ([`898f7dc`](https://github.com/izelnakri/qunitx-cli/commit/898f7dcd2d86880a07f4242e81075fddddc211cb))
- Delay testTimeout fallback to prevent WS/CDP race under concurrent load — 2026-03-19 by [@izelnakri](https://github.com/izelnakri) ([`858d791`](https://github.com/izelnakri/qunitx-cli/commit/858d7913fc72c26ee57772d7b0e3c0572c488ad6))

### Documentation
- Document Playwright multi-browser support — 2026-03-19 by [@izelnakri](https://github.com/izelnakri) ([`d59cf69`](https://github.com/izelnakri/qunitx-cli/commit/d59cf694ca14dfbf3d5f4284ada8c140c09a0ba3))

### Features
- Add multi-browser test support (firefox, webkit) — 2026-03-19 by [@izelnakri](https://github.com/izelnakri) ([`51de1e5`](https://github.com/izelnakri/qunitx-cli/commit/51de1e5778c7c681e8a6e53d000223178e5e3ee5))
- Remove stale old dependencies — 2026-03-19 by [@izelnakri](https://github.com/izelnakri) ([`1b45bb8`](https://github.com/izelnakri/qunitx-cli/commit/1b45bb8d2ed4d7924ec1d37e7a2c7b283e128d0d))

### Performance
- Migrate to playwright-core + CDP pre-launch, add --browser flag, --trace-perf — 2026-03-19 by [@izelnakri](https://github.com/izelnakri) ([`1dcda0a`](https://github.com/izelnakri/qunitx-cli/commit/1dcda0aed7038593e4e6c6757afaa4b4aa749d2d))

### Refactoring
- Remove all puppeteer references, replace with playwright — 2026-03-19 by [@izelnakri](https://github.com/izelnakri) ([`3c9292e`](https://github.com/izelnakri/qunitx-cli/commit/3c9292e61b1999b08e48d8b1b35b8e4cdb8c9c4d))

## [0.8.0] - 2026-03-18
[`v0.7.0...v0.8.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.7.0...v0.8.0)

### Performance
- Replace chokidar with node:fs.watch in setupFileWatchers — 2026-03-18 by [@izelnakri](https://github.com/izelnakri) ([`7bb0bd8`](https://github.com/izelnakri/qunitx-cli/commit/7bb0bd89d40f2907ed57ae7fa339bc6c13805f6c))

## [0.7.0] - 2026-03-18
[`v0.6.0...v0.7.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.6.0...v0.7.0)

### Performance
- Replace cheerio with regex in findInternalAssetsFromHTML (37% startup improvement) — 2026-03-18 by [@izelnakri](https://github.com/izelnakri) ([`244f06e`](https://github.com/izelnakri/qunitx-cli/commit/244f06e163ce121a18c3a33cf86989ec9f12504a))

## [0.6.0] - 2026-03-18
[`v0.5.8...v0.6.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.5.8...v0.6.0)

### Performance
- Replace js-yaml with custom dumpYaml for TAP output (70% faster) — 2026-03-18 by [@izelnakri](https://github.com/izelnakri) ([`d65c38b`](https://github.com/izelnakri/qunitx-cli/commit/d65c38b576d77cd024911583490fc69bfa28b593))

## [0.5.8] - 2026-03-18
[`v0.5.7...v0.5.8`](https://github.com/izelnakri/qunitx-cli/compare/v0.5.7...v0.5.8)

### Bug Fixes
- UnlinkDir events now correctly clean up fsTree in watch mode — 2026-03-18 by [@izelnakri](https://github.com/izelnakri) ([`cb176af`](https://github.com/izelnakri/qunitx-cli/commit/cb176afe8d70e394aa611513bbebb79c5a3c4e14))

### Documentation
- Document extensions config and all package.json qunitx keys in README — 2026-03-18 by [@izelnakri](https://github.com/izelnakri) ([`20e3f63`](https://github.com/izelnakri/qunitx-cli/commit/20e3f63b7d74edfd40882c24abdf451e8bea7359))

### Features
- Add benchmarking system! — 2026-03-18 by [@izelnakri](https://github.com/izelnakri) ([`076b9b7`](https://github.com/izelnakri/qunitx-cli/commit/076b9b774348a1bbdacc06eef5e2235a7eb9e9b8))
- Add configurable extensions with fix for .mjs/.cjs false positives — 2026-03-18 by [@izelnakri](https://github.com/izelnakri) ([`7f198d4`](https://github.com/izelnakri/qunitx-cli/commit/7f198d415c7871dbafeefcbcf18ba18ad963fa09))

## [0.5.7] - 2026-03-17
[`v0.5.6...v0.5.7`](https://github.com/izelnakri/qunitx-cli/compare/v0.5.6...v0.5.7)

### Bug Fixes
- Bugfix for errorCount, timeout flag, fileWatcher unlinkdir — 2026-03-17 by [@izelnakri](https://github.com/izelnakri) ([`e8c6c7e`](https://github.com/izelnakri/qunitx-cli/commit/e8c6c7e453c2a051d9dee8427669893a9661399c))

## [0.5.6] - 2026-03-17
[`v0.5.5...v0.5.6`](https://github.com/izelnakri/qunitx-cli/compare/v0.5.5...v0.5.6)

### Bug Fixes
- Add @deno-types hints for npm packages without bundled type declarations — 2026-03-16 by [@izelnakri](https://github.com/izelnakri) ([`a409f91`](https://github.com/izelnakri/qunitx-cli/commit/a409f91149c9b6697f886c833b33aa4e8d00d4d5))

### Documentation
- Add all the module docs — 2026-03-17 by [@izelnakri](https://github.com/izelnakri) ([`8e2c947`](https://github.com/izelnakri/qunitx-cli/commit/8e2c9472a2089240ab69113c2fabba7306a26ad6))

### Features
- More tests are and optimization of test suite — 2026-03-17 by [@izelnakri](https://github.com/izelnakri) ([`5e5c091`](https://github.com/izelnakri/qunitx-cli/commit/5e5c091ffa63a829a4207781f2ab100de8d5b183))
- Runtime speed optimizations — 2026-03-17 by [@izelnakri](https://github.com/izelnakri) ([`f330119`](https://github.com/izelnakri/qunitx-cli/commit/f330119e0fd0c044e3f18177ed98ea05902aea56))

## [0.5.2] - 2026-03-16
[`v0.5.1...v0.5.2`](https://github.com/izelnakri/qunitx-cli/compare/v0.5.1...v0.5.2)

### Features
- Improve CHANGELOG.md generation — 2026-03-10 by [@izelnakri](https://github.com/izelnakri) ([`2fc700f`](https://github.com/izelnakri/qunitx-cli/commit/2fc700f54e63df2221ce4a33703a4e7d8c88908b))

## [0.5.1] - 2026-03-10
[`v0.5.0...v0.5.1`](https://github.com/izelnakri/qunitx-cli/compare/v0.5.0...v0.5.1)

### Bug Fixes
- Strip query params before route matching in HTTPServer — 2026-03-10 by [@izelnakri](https://github.com/izelnakri) ([`f22d624`](https://github.com/izelnakri/qunitx-cli/commit/f22d624fe6872623a8eab004126e3864cac73ca0))

### Features
- Update vendor folder and .npmignore — 2026-03-10 by [@izelnakri](https://github.com/izelnakri) ([`0c47066`](https://github.com/izelnakri/qunitx-cli/commit/0c47066a96f2bc620eb7a6cc22529a31741df6f4))

## [0.4.0] - 2026-03-09
[`v0.3.0...v0.4.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.3.0...v0.4.0)

### Bug Fixes
- Sync help test expected output with --port flag addition — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`f9b2675`](https://github.com/izelnakri/qunitx-cli/commit/f9b26755e336a3c46257d71c43257031f1ed7516))
- Auto-discover Chrome via findChrome() utility, keeping Makefile simple — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`43028b7`](https://github.com/izelnakri/qunitx-cli/commit/43028b738fda6ba017465a46cd4c35b500176a68))

## [0.3.0] - 2026-03-09
[`v0.2.0...v0.3.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.2.0...v0.3.0)

### Bug Fixes
- Make test runtime more resilient flakiness & memory-wise — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`dd9bea6`](https://github.com/izelnakri/qunitx-cli/commit/dd9bea6f2578a56c5c0311f4f5d5b591175d6cdf))
- Important server/browser concurrency memory leak — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`4c2ab18`](https://github.com/izelnakri/qunitx-cli/commit/4c2ab18bf68e24c973671f7c62a228f33d312bea))
- Initial semaphore server for chrome processes/resources — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`a5bf0ee`](https://github.com/izelnakri/qunitx-cli/commit/a5bf0ee0515d13b370d414611630880af2170953))
- Eliminate IS_PUPPETEER race, zombie Chrome leak, and done-event TAP race — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`c3d1632`](https://github.com/izelnakri/qunitx-cli/commit/c3d1632a6fb9784da70220b5d17eb996ec4fc65f))
- Removed redundant wait before tests start — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`823d317`](https://github.com/izelnakri/qunitx-cli/commit/823d3173e9f00ae09eb0c8f65e76fdcfe0c41858))

### Documentation
- Update README, CHANGELOG, help, and tighten CI permissions — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`6b5b74d`](https://github.com/izelnakri/qunitx-cli/commit/6b5b74d1693084c419cecf6e82cf1d698f139626))
- Demo.gif update — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`dda2193`](https://github.com/izelnakri/qunitx-cli/commit/dda2193b97fd3350760e5b4423452a314a5aaaf5))

### Features
- Concurrent mode splits test files across N groups in shared Chrome — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`e0024db`](https://github.com/izelnakri/qunitx-cli/commit/e0024dbc73cfbd4a480a2d994b7050a11449c20e))

## [0.2.0] - 2026-03-09

### Bug Fixes
- MAJOR BROWSER RUNTIME BUGFIX — 2026-03-08 by [@izelnakri](https://github.com/izelnakri) ([`86c682a`](https://github.com/izelnakri/qunitx-cli/commit/86c682a99470a1cacec9adc4032cee3132fcd016))
- CI linting is now correct — 2026-03-08 by [@izelnakri](https://github.com/izelnakri) ([`ce0f856`](https://github.com/izelnakri/qunitx-cli/commit/ce0f8563eded3791f88ab0dcd6e2001b3886de05))
- Make test runner more resilient — 2026-03-08 by [@izelnakri](https://github.com/izelnakri) ([`2f5de1f`](https://github.com/izelnakri/qunitx-cli/commit/2f5de1f6a972d150a9dcabe61fc0265011b0354b))

### Features
- Major refresh for qunitx-cli after years — 2026-03-08 by [@izelnakri](https://github.com/izelnakri) ([`c0d50a3`](https://github.com/izelnakri/qunitx-cli/commit/c0d50a3bd53a61602b57bd1698c27d747b7de4fa))


