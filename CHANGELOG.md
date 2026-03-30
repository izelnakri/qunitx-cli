# Changelog

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


