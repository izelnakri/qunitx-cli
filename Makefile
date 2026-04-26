.DEFAULT_GOAL := help

LEVEL ?= patch

.PHONY: help fix fmt format check lint lint-docs test test-debug dev test-chrome test-firefox test-webkit test-all-browsers test-release build coverage coverage-report docs demo bench-print bench bench-update bench-check build-sea release



REGRESSION_THRESHOLD ?= 26

help:
	@echo "Usage: make <target> [LEVEL=patch|minor|major] [REGRESSION_THRESHOLD=26]"
	@echo ""
	@echo "  fix             Auto-fix formatting"
	@echo "  format          Check formatting (prettier)"
	@echo "  lint            Check code quality (deno lint)"
	@echo "  bench-typecheck Type-check benchmark files (catches Node-globals leaks under Deno)"
	@echo "  check           Format + lint + bench-typecheck + tests"
	@echo "  test            Run full test suite (chromium)"
	@echo "  test-debug      Run full test suite with --debug on all qunitx invocations"
	@echo "  dev             Watch all tests with --debug (for development)"
	@echo "  test-chrome     Alias for test"
	@echo "  test-firefox    Run browser tests with Firefox (requires: npx playwright install firefox)"
	@echo "  test-webkit     Run browser tests with WebKit (requires: npx playwright install webkit)"
	@echo "  test-all-browsers Run full suite on chromium, then browser tests on firefox + webkit"
	@echo "  test-release    Build, pack, install tarball, run full suite against the binary"
	@echo "  build           Build the project"
	@echo "  coverage        Run tests with coverage report"
	@echo "  demo            Regenerate docs/demo.gif"
	@echo "  bench-print     Run all benchmarks (display only, no save)"
	@echo "  bench           Run all benchmarks and save results as new baseline"
	@echo "  bench-update    Alias for bench"
	@echo "  bench-check     Run benchmarks and fail if regression > REGRESSION_THRESHOLD%"
	@echo "  build-sea       Build SEA binary for the local platform and publish its npm package"
	@echo "  release         Bump version, update changelog, tag, push, publish to npm"
	@echo ""
	@echo "Env-var escape hatches:"
	@echo "  SKIP_BENCHMARK=true                       skip bench-check entirely (e.g. SKIP_BENCHMARK=true make release)"
	@echo "  SKIP_BENCHMARK=<file>[,<file>...]         skip specific bench files by basename, e.g. SKIP_BENCHMARK=e2e,tap"

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

# Type-check the benchmark files (and their lib/ imports) under Deno.
# Catches Node-globals leaking into shared code (e.g. raw `Buffer` references
# without a node:buffer import) which would otherwise only surface in CI bench.
bench-typecheck:
	deno check 'benches/**/*.ts'

docs:
	npm run docs

check: format lint lint-docs bench-typecheck test

test:
	npm test

test-debug:
	npm run test:debug

dev:
	npm run dev

test-chrome: test

test-firefox:
	QUNITX_BROWSER=firefox npm run test:browser

test-webkit:
	QUNITX_BROWSER=webkit npm run test:browser

test-all-browsers: test test-firefox test-webkit

test-release:
	bash scripts/test-release.sh

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
# Exits non-zero if any benchmark regresses more than REGRESSION_THRESHOLD% (default: 26).
# Run 'make bench-update' once first to establish the baseline.
#
# Set SKIP_BENCHMARK=true to skip the gate entirely (useful when laptop load
# makes spawn-based benches falsely regress).  SKIP_BENCHMARK=<file>[,<file>...]
# skips individual bench files by basename — e.g. SKIP_BENCHMARK=e2e,tap.
# The check-benchmarks.ts script also handles partial-skip values; this short-
# circuits the full-skip case so we don't even pay deno startup time.
bench-check:
	@if echo "$(SKIP_BENCHMARK)" | grep -qiE '^(true|1|all)$$'; then \
		echo "SKIP_BENCHMARK=$(SKIP_BENCHMARK) → skipping bench-check"; \
	else \
		echo "Running benchmark regression check (silent until done, ~30s)..."; \
		REGRESSION_THRESHOLD=$(REGRESSION_THRESHOLD) SKIP_BENCHMARK="$(SKIP_BENCHMARK)" deno task bench:check; \
	fi


# Builds a Node.js SEA binary for the current platform, places it in the
# matching npm/<target>/bin/ directory, and publishes that platform package.
# Automatically detects linux-x64, linux-arm64, darwin-arm64, darwin-x64.
build-sea:
	@NODE_PLATFORM=$$(node -p "process.platform"); \
	NODE_ARCH=$$(node -p "process.arch"); \
	if [ "$$NODE_PLATFORM" = "darwin" ]; then TARGET="darwin-$$NODE_ARCH"; \
	elif [ "$$NODE_PLATFORM" = "linux" ]; then TARGET="linux-$$NODE_ARCH"; \
	else echo "Unsupported platform: $$NODE_PLATFORM-$$NODE_ARCH" && exit 1; fi; \
	echo "Building SEA for $$TARGET..."; \
	PREAMBLE=';(function(){if(!process.env.ESBUILD_BINARY_PATH){var path=require("path"),fs=require("fs");["esbuild","esbuild.exe"].forEach(function(n){var p=path.join(path.dirname(process.execPath),n);try{fs.accessSync(p,fs.constants.X_OK);process.env.ESBUILD_BINARY_PATH=p;}catch(_){}});}})();'; \
	npx esbuild cli.ts --bundle --platform=node --format=cjs --banner:js="$$PREAMBLE" \
	  --outfile=sea-entry.cjs --external:fsevents --external:typescript --external:chromium-bidi \
	  --external:playwright-core \
	  --log-level=warning \
	  --log-override:empty-import-meta=silent \
	  --log-override:require-resolve-not-external=silent; \
	node scripts/write-sea-config.js; \
	node --experimental-sea-config sea-config.json; \
	rm -f qunitx-sea; \
	cp "$$(node --input-type=commonjs -e 'process.stdout.write(process.execPath)')" qunitx-sea; \
	chmod u+w qunitx-sea; \
	codesign --remove-signature qunitx-sea 2>/dev/null || true; \
	if [ "$$NODE_PLATFORM" = "darwin" ]; then \
	  npx --yes postject qunitx-sea NODE_SEA_BLOB sea.blob \
	    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
	    --macho-segment-name NODE_SEA; \
	else \
	  npx --yes postject qunitx-sea NODE_SEA_BLOB sea.blob \
	    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2; \
	fi; \
	codesign --sign - qunitx-sea 2>/dev/null || true; \
	chmod +x qunitx-sea; \
	rm -rf npm/$$TARGET/bin && mkdir -p npm/$$TARGET/bin; \
	cp qunitx-sea npm/$$TARGET/bin/qunitx; \
	VERSION=$$(node -p 'require("./package.json").version'); \
	node scripts/set-pkg-version.js npm/$$TARGET/package.json $$VERSION; \
	npm publish ./npm/$$TARGET --access public; \
	rm -f sea-entry.cjs sea-config.json sea.blob qunitx-sea

# Lint, bump version, changelog, publish (SEA + JS), commit, tag, push.
# Publishes the main package (JS fallback) and the local platform's SEA package.
# CI then pushes the versioned Docker image, builds binaries, and creates the GitHub release.
#
# Order matters: publish before commit/tag so the release commit contains the final
# clean state of package.json/package-lock.json (no leftover optionalDependencies).
#
# Usage: make release LEVEL=patch|minor|major
release:
	@test -n "$(LEVEL)" || (echo "Usage: make release LEVEL=patch|minor|major" && exit 1)
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "WARNING: Uncommitted changes detected — these will NOT be included in the release:"; \
		git status --short; \
		echo ""; \
	fi
	@eval $$(ssh-agent -s); trap "ssh-agent -k > /dev/null" EXIT; ssh-add
	@npm whoami > /dev/null 2>&1 || npm login
	@echo "npm user: $$(npm whoami) | $$(date '+%Y-%m-%d %H:%M:%S %Z')"
	$(MAKE) bench-check
	$(MAKE) check
	npm run test:release
	npm version $(LEVEL) --no-git-tag-version
	@for d in npm/*/; do node scripts/set-pkg-version.js "$$d/package.json" "$$(node -p 'require("./package.json").version')"; done
	$(MAKE) build-sea
	@NODE_PLATFORM=$$(node -p "process.platform"); \
	NODE_ARCH=$$(node -p "process.arch"); \
	if [ "$$NODE_PLATFORM" = "darwin" ]; then TARGET="darwin-$$NODE_ARCH"; \
	elif [ "$$NODE_PLATFORM" = "linux" ]; then TARGET="linux-$$NODE_ARCH"; \
	else TARGET=""; fi; \
	if [ -n "$$TARGET" ]; then \
	  PKG="qunitx-cli-$$TARGET"; \
	  node scripts/add-optional-dep.js $$PKG; \
	  npm install --package-lock-only --ignore-scripts; \
	fi
	npm publish --access public
	@node scripts/remove-optional-deps.js
	@npm install --package-lock-only --ignore-scripts
	git-cliff --tag "v$$(node -p 'require("./package.json").version')" --output CHANGELOG.md
	git add package.json package-lock.json CHANGELOG.md npm/*/package.json
	git commit -m "Release $$(node -p 'require("./package.json").version')"
	git tag "v$$(node -p 'require("./package.json").version')"
	git push && git push --tags
	$(MAKE) bench
