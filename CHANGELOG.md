# Changelog

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


