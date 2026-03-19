.DEFAULT_GOAL := help

LEVEL ?= patch

.PHONY: help fix fmt format check lint lint-docs test test-chrome test-firefox test-webkit test-all-browsers build coverage coverage-report docs demo bench-print bench bench-update bench-check release



REGRESSION_THRESHOLD ?= 20

help:
	@echo "Usage: make <target> [LEVEL=patch|minor|major] [REGRESSION_THRESHOLD=20]"
	@echo ""
	@echo "  fix             Auto-fix formatting"
	@echo "  format          Check formatting (prettier)"
	@echo "  lint            Check code quality (deno lint)"
	@echo "  check           Format + lint + tests"
	@echo "  test            Run full test suite (chromium)"
	@echo "  test-chrome     Alias for test"
	@echo "  test-firefox    Run browser tests with Firefox (requires: npx playwright install firefox)"
	@echo "  test-webkit     Run browser tests with WebKit (requires: npx playwright install webkit)"
	@echo "  test-all-browsers Run full suite on chromium, then browser tests on firefox + webkit"
	@echo "  build           Build the project"
	@echo "  coverage        Run tests with coverage report"
	@echo "  demo            Regenerate docs/demo.gif"
	@echo "  bench-print     Run all benchmarks (display only, no save)"
	@echo "  bench           Run all benchmarks and save results as new baseline"
	@echo "  bench-update    Alias for bench"
	@echo "  bench-check     Run benchmarks and fail if regression > REGRESSION_THRESHOLD%"
	@echo "  release         Bump version, update changelog, tag, push, publish to npm"

fix:
	npm run format:fix

fmt:
	npm run format:fix

format:
	npm run format

lint:
	npm run lint

lint-docs:
	npm run lint:docs

docs:
	npm run docs

check: format lint lint-docs test

test:
	npm test

test-chrome: test

test-firefox:
	QUNITX_BROWSER=firefox npm run test:browser

test-webkit:
	QUNITX_BROWSER=webkit npm run test:browser

test-all-browsers: test test-firefox test-webkit

build:
	npm run build

coverage:
	npx c8 --reporter=lcov --reporter=text --reporter=html npm test

coverage-report:
	npx c8 --reporter=lcov --reporter=text --reporter=html --open npm test

# Regenerate docs/demo.gif (composite terminal + browser GIF).
# Requires: nix (for vhs, ffmpeg, gifsicle), CHROME_BIN set or Nix-resolved chromium.
demo:
	bash docs/make-demo-gif.sh

bench-print:
	deno task bench

bench:
	deno task bench:update

bench-update: bench

# Runs all benchmarks and compares results against benches/results.json.
# Exits non-zero if any benchmark regresses more than REGRESSION_THRESHOLD% (default: 20).
# Run 'make bench-update' once first to establish the baseline.
bench-check:
	REGRESSION_THRESHOLD=$(REGRESSION_THRESHOLD) deno task bench:check


# Lint, bump version, update changelog, commit, tag, push, publish to npm.
# CI then pushes the versioned Docker image, builds binaries, and creates the GitHub release.
# Usage: make release LEVEL=patch|minor|major
release:
	@test -n "$(LEVEL)" || (echo "Usage: make release LEVEL=patch|minor|major" && exit 1)
	@npm whoami 2>/dev/null || npm login
	$(MAKE) check
	$(MAKE) bench-check
	npm version $(LEVEL) --no-git-tag-version
	git-cliff --tag "v$$(node -p 'require("./package.json").version')" --output CHANGELOG.md
	git add package.json package-lock.json CHANGELOG.md
	git commit -m "Release $$(node -p 'require("./package.json").version')"
	git tag "v$$(node -p 'require("./package.json").version')"
	git push && git push --tags
	npm publish --access public
	$(MAKE) bench
