# Changelog

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


