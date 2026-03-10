# Changelog

All notable changes to this project will be documented in this file.
## Unreleased
- Fix: strip query params before route matching in HTTPServer
- Feat: update vendor folder and .npmignore
## 0.5.0 — 2026-03-10
- Release 0.5.0
## 0.4.0 — 2026-03-09
- Release 0.4.0
- Fix: auto-discover Chrome via findChrome() utility, keeping Makefile simple
- Fix: sync help test expected output with --port flag addition
- Ci: adjust release pipeline according to gitprint
## 0.3.0 — 2026-03-09
- Release 0.3.0
- Dev: cleanup/improve package-lock.json
- Doc: demo.gif update
- Docs: update README, CHANGELOG, help, and tighten CI permissions
- Chore: update all GitHub Actions to latest major versions
- Feat: concurrent mode splits test files across N groups in shared Chrome
- Fix: removed redundant wait before tests start
- Fix: eliminate IS_PUPPETEER race, zombie Chrome leak, and done-event TAP race
- Fix: initial semaphore server for chrome processes/resources
- Fix: important server/browser concurrency memory leak
- Fix: make test runtime more resilient flakiness & memory-wise
- Ci: optimize test suite time
## 0.2.0 — 2026-03-09
- Release 0.2.0
- Ci: move project node.js target to v24 LTS
- Dev: new CI release and demo workflow
- Fix: make test runner more resilient
- Fix: CI linting is now correct
- Ci: renew the CI completely
- Dev: significantly speed up tests and make them decoupled during run
- Fix: MAJOR BROWSER RUNTIME BUGFIX
- Feature: major refresh for qunitx-cli after years
- First config struct generation optimization
- Release 0.1.2
- Remove redundant jsdom package
- Use non-slim flake & bump qunitx
- Bump docker/setup-buildx-action from 2.9.0 to 2.9.1 (#2)
- Release 0.1.1
- Merge pull request #6 from izelnakri/update-deps
- Make default devShell also use the slim node v20.5
- Update puppeteer to 20.9.0 & qunitx to latest
- Fix docker-deploy.yml file
- Merge pull request #3 from izelnakri/nix-ci
- Use nodejs-slim_20 flake
- Run docker deploy on main branch or tags
- Final nix-based-ci workflow
- Move to single line nix test command
- Nix CI trial
- Optimize npm dist (#4)
- Release 0.1.0
- Pkg upgrades & github CI
- Remove --browser flag from help
- Add TODO
- Release 0.0.3
- Built the foundation for development
- Release 0.0.2
- Init

