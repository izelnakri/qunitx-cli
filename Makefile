.DEFAULT_GOAL := help

LEVEL ?= patch

.PHONY: help fix fmt format check lint test build coverage coverage-report demo release

help:
	@echo "Usage: make <target> [LEVEL=patch|minor|major]"
	@echo ""
	@echo "  fix             Auto-fix formatting"
	@echo "  format          Check formatting (prettier)"
	@echo "  lint            Check code quality (deno lint)"
	@echo "  check           Format + lint + tests"
	@echo "  test            Run all tests"
	@echo "  build           Build the project"
	@echo "  coverage        Run tests with coverage report"
	@echo "  demo            Regenerate docs/demo.gif"
	@echo "  release         Bump version, update changelog, tag, push, publish to npm"

fix:
	npm run format:fix

fmt:
	npm run format:fix

format:
	npm run format

lint:
	npm run lint

check: format lint test

test:
	npm test

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

# Lint, bump version, update changelog, commit, tag, push, publish to npm.
# CI then pushes the versioned Docker image, builds binaries, and creates the GitHub release.
# Usage: make release LEVEL=patch|minor|major
release:
	@test -n "$(LEVEL)" || (echo "Usage: make release LEVEL=patch|minor|major" && exit 1)
	@npm whoami 2>/dev/null || npm login
	$(MAKE) check
	npm version $(LEVEL) --no-git-tag-version
	npm run changelog:update
	git add package.json package-lock.json CHANGELOG.md
	git commit -m "Release $$(node -p 'require("./package.json").version')"
	git tag "v$$(node -p 'require("./package.json").version')"
	git push && git push --tags
	npm publish --access public
