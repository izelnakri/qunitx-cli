.PHONY: check test lint build demo release

check: lint test

lint:
	npm run lint

test:
	npm test

build:
	npm run build

# Regenerate demo/demo.gif using VHS.
# Requires: vhs (brew install vhs | nix profile install nixpkgs#vhs)
#           Chrome (google-chrome-stable or chromium)
demo:
	@which vhs > /dev/null 2>&1 || (echo "vhs not found — install: brew install vhs  or  nix profile install nixpkgs#vhs" && exit 1)
	@CHROME=$$(which google-chrome-stable 2>/dev/null || which google-chrome 2>/dev/null || which chromium 2>/dev/null); \
	test -n "$$CHROME" || (echo "Chrome not found — install google-chrome-stable or chromium" && exit 1); \
	CHROME_BIN=$$CHROME vhs demo/demo.tape

# Lint, bump version, update changelog, commit, tag, push, publish to npm.
# CI then pushes the versioned Docker image and creates the GitHub release.
# Usage: make release LEVEL=patch|minor|major
release:
	@test -n "$(LEVEL)" || (echo "Usage: make release LEVEL=patch|minor|major" && exit 1)
	npm run lint
	npm version $(LEVEL) --no-git-tag-version
	npm run changelog:update
	git add package.json package-lock.json CHANGELOG.md
	git commit -m "Release $$(node -p 'require("./package.json").version')"
	git tag "v$$(node -p 'require("./package.json").version')"
	git push && git push --tags
	npm publish --access public
