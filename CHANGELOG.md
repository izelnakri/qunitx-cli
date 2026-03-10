# Changelog

All notable changes to this project will be documented in this file.

## [0.5.1] - 2026-03-10
[`v0.5.0...v0.5.1`](https://github.com/izelnakri/qunitx-cli/compare/v0.5.0...v0.5.1)

### Bug Fixes
- Strip query params before route matching in HTTPServer — 2026-03-10 by [@izelnakri](https://github.com/izelnakri) ([`f22d624`](https://github.com/izelnakri/qunitx-cli/commit/f22d624fe6872623a8eab004126e3864cac73ca0))

### Features
- Update vendor folder and .npmignore — 2026-03-10 by [@izelnakri](https://github.com/izelnakri) ([`0c47066`](https://github.com/izelnakri/qunitx-cli/commit/0c47066a96f2bc620eb7a6cc22529a31741df6f4))

## [0.5.0] - 2026-03-10
[`v0.4.0...v0.5.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.4.0...v0.5.0)

## [0.4.0] - 2026-03-10
[`v0.3.0...v0.4.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.3.0...v0.4.0)

### Bug Fixes
- Auto-discover Chrome via findChrome() utility, keeping Makefile simple — 2026-03-10 by [@izelnakri](https://github.com/izelnakri) ([`43028b7`](https://github.com/izelnakri/qunitx-cli/commit/43028b738fda6ba017465a46cd4c35b500176a68))
- Sync help test expected output with --port flag addition — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`f9b2675`](https://github.com/izelnakri/qunitx-cli/commit/f9b26755e336a3c46257d71c43257031f1ed7516))

### CI
- Adjust release pipeline according to gitprint — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`a326593`](https://github.com/izelnakri/qunitx-cli/commit/a3265934d1cec5f66d691409822b0968b739c086))

## [0.3.0] - 2026-03-09
[`v0.2.0...v0.3.0`](https://github.com/izelnakri/qunitx-cli/compare/v0.2.0...v0.3.0)

### Features
- Concurrent mode splits test files across N groups in shared Chrome — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`e0024db`](https://github.com/izelnakri/qunitx-cli/commit/e0024dbc73cfbd4a480a2d994b7050a11449c20e))

### Bug Fixes
- Eliminate IS_PUPPETEER race, zombie Chrome leak, and done-event TAP race — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`c3d1632`](https://github.com/izelnakri/qunitx-cli/commit/c3d1632a6fb9784da70220b5d17eb996ec4fc65f))
- Initial semaphore server for chrome processes/resources — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`a5bf0ee`](https://github.com/izelnakri/qunitx-cli/commit/a5bf0ee0515d13b370d414611630880af2170953))
- Important server/browser concurrency memory leak — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`4c2ab18`](https://github.com/izelnakri/qunitx-cli/commit/4c2ab18bf68e24c973671f7c62a228f33d312bea))
- Make test runtime more resilient flakiness & memory-wise — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`dd9bea6`](https://github.com/izelnakri/qunitx-cli/commit/dd9bea6f2578a56c5c0311f4f5d5b591175d6cdf))
- Removed redundant wait before tests start — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`823d317`](https://github.com/izelnakri/qunitx-cli/commit/823d3173e9f00ae09eb0c8f65e76fdcfe0c41858))

### CI
- Optimize test suite time — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`930dd8c`](https://github.com/izelnakri/qunitx-cli/commit/930dd8c001f8698d25c46d6f6492eee7dcae9d0e))

### Documentation
- Update README, CHANGELOG, help, and tighten CI permissions — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`6b5b74d`](https://github.com/izelnakri/qunitx-cli/commit/6b5b74d1693084c419cecf6e82cf1d698f139626))
- Demo.gif update — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`dda2193`](https://github.com/izelnakri/qunitx-cli/commit/dda2193b97fd3350760e5b4423452a314a5aaaf5))

### Chores
- Update all GitHub Actions to latest major versions — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`26dca3f`](https://github.com/izelnakri/qunitx-cli/commit/26dca3fb150a8703206d8695317ddad2f18ff768))
- Cleanup/improve package-lock.json — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`3fe8261`](https://github.com/izelnakri/qunitx-cli/commit/3fe826159f4511f00d153061068e0da3c63cd612))

## [0.2.0] - 2026-03-09
[`0.1.2...v0.2.0`](https://github.com/izelnakri/qunitx-cli/compare/0.1.2...v0.2.0)

### Features
- Major refresh for qunitx-cli after years — 2026-03-08 by [@izelnakri](https://github.com/izelnakri) ([`c0d50a3`](https://github.com/izelnakri/qunitx-cli/commit/c0d50a3bd53a61602b57bd1698c27d747b7de4fa))

### Bug Fixes
- MAJOR BROWSER RUNTIME BUGFIX — 2026-03-08 by [@izelnakri](https://github.com/izelnakri) ([`86c682a`](https://github.com/izelnakri/qunitx-cli/commit/86c682a99470a1cacec9adc4032cee3132fcd016))
- Make test runner more resilient — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`2f5de1f`](https://github.com/izelnakri/qunitx-cli/commit/2f5de1f6a972d150a9dcabe61fc0265011b0354b))
- CI linting is now correct — 2026-03-08 by [@izelnakri](https://github.com/izelnakri) ([`ce0f856`](https://github.com/izelnakri/qunitx-cli/commit/ce0f8563eded3791f88ab0dcd6e2001b3886de05))
- First config struct generation optimization — 2023-08-01 by [@izelnakri](https://github.com/izelnakri) ([`679e059`](https://github.com/izelnakri/qunitx-cli/commit/679e059b5d46e5fde6fa2ac8613dcefcfd45fccb))

### CI
- Move project node.js target to v24 LTS — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`6b55b85`](https://github.com/izelnakri/qunitx-cli/commit/6b55b85afe27e174c929eeab7bd7c2853f37f2e7))
- Renew the CI completely — 2026-03-08 by [@izelnakri](https://github.com/izelnakri) ([`526259b`](https://github.com/izelnakri/qunitx-cli/commit/526259ba692ca1e2240f2a36f79e330a1eddf6ca))

### Chores
- New CI release and demo workflow — 2026-03-09 by [@izelnakri](https://github.com/izelnakri) ([`4a56918`](https://github.com/izelnakri/qunitx-cli/commit/4a56918ed1ce7a50bdb3fdcf301db9edeecd0eda))
- Significantly speed up tests and make them decoupled during run — 2026-03-08 by [@izelnakri](https://github.com/izelnakri) ([`4d97bf4`](https://github.com/izelnakri/qunitx-cli/commit/4d97bf4a04c1f1cbdf2b2e2c7ba09e5a06ffe895))

## [0.1.2] - 2023-08-01
[`0.1.1...0.1.2`](https://github.com/izelnakri/qunitx-cli/compare/0.1.1...0.1.2)

### Bug Fixes
- Remove redundant jsdom package — 2023-08-01 by [@izelnakri](https://github.com/izelnakri) ([`7eb4d4e`](https://github.com/izelnakri/qunitx-cli/commit/7eb4d4e8a9bd45c9e133a55bf83f24d5eff3eb65))
- Use non-slim flake & bump qunitx — 2023-08-01 by [@izelnakri](https://github.com/izelnakri) ([`ce0962a`](https://github.com/izelnakri/qunitx-cli/commit/ce0962a209999529b40dc329e35ffd787c69ee65))
- Bump docker/setup-buildx-action from 2.9.0 to 2.9.1 (#2) — 2023-08-01 by [@dependabot](https://github.com/apps/dependabot) ([`1bdf141`](https://github.com/izelnakri/qunitx-cli/commit/1bdf14193bad0794268cf9c6a13edbf239ecb585))

## [0.1.1] - 2023-08-01
[`0.1.0...0.1.1`](https://github.com/izelnakri/qunitx-cli/compare/0.1.0...0.1.1)

### Chores
- Optimize npm dist (#4) — 2023-08-01 by [@izelnakri](https://github.com/izelnakri) ([`7cc4961`](https://github.com/izelnakri/qunitx-cli/commit/7cc49611d1e4919d20105e02c41c6efe3c28cb95))
- Merge pull request #6 from izelnakri/update-deps — 2023-08-01 by [@izelnakri](https://github.com/izelnakri) ([`528325d`](https://github.com/izelnakri/qunitx-cli/commit/528325d6e8168ff245c742c7d49578a17bebf3d7))
- Make default devShell also use the slim node v20.5 — 2023-08-01 by [@izelnakri](https://github.com/izelnakri) ([`577853e`](https://github.com/izelnakri/qunitx-cli/commit/577853eea72c5cc999dfdfa3a8480b5a6d5ca52a))
- Update puppeteer to 20.9.0 & qunitx to latest — 2023-08-01 by [@izelnakri](https://github.com/izelnakri) ([`c4ab86b`](https://github.com/izelnakri/qunitx-cli/commit/c4ab86b26b1eaa1b4ebffe77af4d0b2430323929))
- Fix docker-deploy.yml file — 2023-08-01 by [@izelnakri](https://github.com/izelnakri) ([`3dec7e6`](https://github.com/izelnakri/qunitx-cli/commit/3dec7e6acdcf6da229b7199ae7b2bfd7d874249d))
- Merge pull request #3 from izelnakri/nix-ci — 2023-08-01 by [@izelnakri](https://github.com/izelnakri) ([`f174d9c`](https://github.com/izelnakri/qunitx-cli/commit/f174d9c7bdf5572d5f88643f867101d5af7730de))
- Use nodejs-slim_20 flake — 2023-08-01 by [@izelnakri](https://github.com/izelnakri) ([`26b6ffd`](https://github.com/izelnakri/qunitx-cli/commit/26b6ffd98ada4e54152f5ab31c9fc47fb820b24a))
- Run docker deploy on main branch or tags — 2023-08-01 by [@izelnakri](https://github.com/izelnakri) ([`20a28d3`](https://github.com/izelnakri/qunitx-cli/commit/20a28d3f5873fbd7134bd29d9f8c2deef3931c8f))
- Final nix-based-ci workflow — 2023-07-31 by [@izelnakri](https://github.com/izelnakri) ([`8ca4051`](https://github.com/izelnakri/qunitx-cli/commit/8ca405197d4ebb2d571a8fd478ed3b7b1b26c2f2))
- Move to single line nix test command — 2023-07-31 by [@izelnakri](https://github.com/izelnakri) ([`f535ee3`](https://github.com/izelnakri/qunitx-cli/commit/f535ee3773471194029658f8397c2a2a9e57bbc0))
- Nix CI trial — 2023-07-31 by [@izelnakri](https://github.com/izelnakri) ([`c4f84d5`](https://github.com/izelnakri/qunitx-cli/commit/c4f84d571edd1fd3445432b94a819c22c773013d))

## [0.1.0] - 2023-07-18
[`0.0.3...0.1.0`](https://github.com/izelnakri/qunitx-cli/compare/0.0.3...0.1.0)

### Chores
- Pkg upgrades & github CI — 2023-07-18 by [@izelnakri](https://github.com/izelnakri) ([`7a33c07`](https://github.com/izelnakri/qunitx-cli/commit/7a33c07ef9c7b404458ac8b46f97c11009fe32fa))
- Remove --browser flag from help — 2023-07-16 by [@izelnakri](https://github.com/izelnakri) ([`011c5ae`](https://github.com/izelnakri/qunitx-cli/commit/011c5aecb1e293bb57aa396d7ceac0fca349298f))
- Add TODO — 2023-07-13 by [@izelnakri](https://github.com/izelnakri) ([`35a5121`](https://github.com/izelnakri/qunitx-cli/commit/35a512135d9b5abab740bfde9ae6ecb1781ab26b))

## [0.0.3] - 2023-07-13
[`0.0.2...0.0.3`](https://github.com/izelnakri/qunitx-cli/compare/0.0.2...0.0.3)

### Chores
- Built the foundation for development — 2023-07-13 by [@izelnakri](https://github.com/izelnakri) ([`569d860`](https://github.com/izelnakri/qunitx-cli/commit/569d8606b75287aceeaaf0b711139650182cd6c4))

## [0.0.2] - 2023-07-13

### Chores
- Init — 2023-07-13 by [@izelnakri](https://github.com/izelnakri) ([`4d2ac8f`](https://github.com/izelnakri/qunitx-cli/commit/4d2ac8fd98ce7a4c988f9036064a6ef592b55f8f))
