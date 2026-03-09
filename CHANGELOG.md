# Changelog

All notable changes to this project will be documented in this file.
## Unreleased
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

Bumps [docker/setup-buildx-action](https://github.com/docker/setup-buildx-action) from 2.9.0 to 2.9.1.
- [Release notes](https://github.com/docker/setup-buildx-action/releases)
- [Commits](https://github.com/docker/setup-buildx-action/compare/v2.9.0...v2.9.1)

---
updated-dependencies:
- dependency-name: docker/setup-buildx-action
  dependency-type: direct:production
  update-type: version-update:semver-patch
...

Signed-off-by: dependabot[bot] <support@github.com>
Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>
- Release 0.1.1
- Merge pull request #6 from izelnakri/update-deps

Update puppeteer to 20.9.0 & qunitx to latest
- Make default devShell also use the slim node v20.5
- Update puppeteer to 20.9.0 & qunitx to latest
- Fix docker-deploy.yml file
- Merge pull request #3 from izelnakri/nix-ci

Nix-based CI
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

