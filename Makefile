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

# Preview unreleased changelog, confirm, run lint + tests, bump version,
# update CHANGELOG.md, commit, tag, push, and create the GitHub release.
# The CI release workflow then publishes to npm and pushes a versioned
# Docker image — authenticated via OIDC, no stored secrets required.
#
# One-time setup on npmjs.com required for OIDC publishing:
#   npmjs.com → package → Settings → Automated publishing → Add publisher
#   Set: owner=izelnakri  repo=qunitx-cli  workflow=release.yml
#
# Usage: make release LEVEL=patch|minor|major
release:
	@test -n "$(LEVEL)" || (echo "Usage: make release LEVEL=patch|minor|major" && exit 1)
	@printf "\n=== Unreleased changes ($(LEVEL) release) ===\n\n"
	@npm run --silent changelog:unreleased
	@printf "\nProceed with $(LEVEL) release? [y/N] " > /dev/tty; \
	read confirm < /dev/tty; \
	case "$$confirm" in \
		[yY]*) \
			npm run --silent changelog:unreleased > /tmp/qunitx-release-notes.md; \
			$(MAKE) check || { rm -f /tmp/qunitx-release-notes.md; exit 1; }; \
			npm version $(LEVEL) --no-git-tag-version && \
			npm run changelog:update && \
			git add package.json package-lock.json CHANGELOG.md && \
			git commit -m "Release $$(node -p 'require("./package.json").version')" && \
			TAG="v$$(node -p 'require("./package.json").version')" && \
			git tag "$$TAG" && \
			git push && git push --tags && \
			gh release create "$$TAG" --title "$$TAG" --notes-file /tmp/qunitx-release-notes.md && \
			rm -f /tmp/qunitx-release-notes.md \
		;; \
		*) printf "Aborted.\n" > /dev/tty; exit 1 ;; \
	esac
