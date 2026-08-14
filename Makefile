.DEFAULT_GOAL := help

LEVEL ?= patch
REGRESSION_THRESHOLD ?= 26

.PHONY: bench bench-check bench-print bench-typecheck bench-update build build-deno build-deno-all build-sea check coverage coverage-report demo dev docs fix fmt format help lint lint-docs release smoke-deno smoke-sea test test-all-browsers test-chrome test-debug test-firefox test-release test-webkit vendor

bench:
	deno task bench:update

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

bench-print:
	deno task bench

# Type-check the benchmark files (and their lib/ imports) under Deno.
# Catches Node-globals leaking into shared code (e.g. raw `Buffer` references
# without a node:buffer import) which would otherwise only surface in CI bench.
bench-typecheck:
	deno check 'benches/**/*.ts'

bench-update: bench

build:
	npm run build

# Builds a Deno-compiled binary into dist/qunitx for the local host platform.
# The binary embeds the JS module graph + templates but cannot embed the platform-
# native esbuild executable. cli.ts auto-discovers an `esbuild` (or `esbuild.exe`)
# adjacent to the binary at runtime; we copy the local @esbuild/<target> sidecar
# next to dist/qunitx so the binary works out of the box without env vars.
build-deno:
	@mkdir -p dist
	deno task build:binary
	@NODE_PLATFORM=$$(node -p "process.platform"); \
	NODE_ARCH=$$(node -p "process.arch"); \
	case "$$NODE_PLATFORM-$$NODE_ARCH" in \
	  linux-x64)    ESBUILD_SRC=node_modules/@esbuild/linux-x64/bin/esbuild;    ESBUILD_DST=esbuild;;     \
	  linux-arm64)  ESBUILD_SRC=node_modules/@esbuild/linux-arm64/bin/esbuild;  ESBUILD_DST=esbuild;;     \
	  darwin-x64)   ESBUILD_SRC=node_modules/@esbuild/darwin-x64/bin/esbuild;   ESBUILD_DST=esbuild;;     \
	  darwin-arm64) ESBUILD_SRC=node_modules/@esbuild/darwin-arm64/bin/esbuild; ESBUILD_DST=esbuild;;     \
	  win32-x64)    ESBUILD_SRC=node_modules/@esbuild/win32-x64/esbuild.exe;    ESBUILD_DST=esbuild.exe;; \
	  *) echo "Unsupported platform: $$NODE_PLATFORM-$$NODE_ARCH" && exit 1;;                            \
	esac; \
	cp "$$ESBUILD_SRC" "dist/$$ESBUILD_DST"; \
	echo "Built dist/qunitx (+ dist/$$ESBUILD_DST sidecar)"

# Cross-compiles for every supported platform into dist/qunitx-<target>{.exe}.
# Each target uses --target and --output. Sidecars are NOT copied here (you'd need
# the per-target @esbuild/<target> package; install with `npm i -D @esbuild/<...>`
# or download from registry.npmjs.org). Distribution scripts handle the pairing.
build-deno-all:
	@mkdir -p dist
	deno compile --allow-all --no-check --target x86_64-unknown-linux-gnu  --include templates --include lib --include package.json --output dist/qunitx-linux-x64       cli.ts
	deno compile --allow-all --no-check --target aarch64-unknown-linux-gnu --include templates --include lib --include package.json --output dist/qunitx-linux-arm64     cli.ts
	deno compile --allow-all --no-check --target x86_64-apple-darwin       --include templates --include lib --include package.json --output dist/qunitx-darwin-x64      cli.ts
	deno compile --allow-all --no-check --target aarch64-apple-darwin      --include templates --include lib --include package.json --output dist/qunitx-darwin-arm64    cli.ts
	deno compile --allow-all --no-check --target x86_64-pc-windows-msvc    --include templates --include lib --include package.json --output dist/qunitx-windows-x64.exe cli.ts

# Builds a Node.js SEA binary for the current platform, places it in the
# matching npm/<target>/bin/ directory, and publishes that platform package.
# Automatically detects linux-x64, linux-arm64, darwin-arm64, darwin-x64.
build-sea:
# The whole recipe is one shell, so a trap covers the paths `||` cannot: Ctrl-C, SIGTERM, a killed
# terminal. Without it an interrupted build left sea-entry.cjs, sea-config.json, sea.blob and
# qunitx-sea in the repo root as untracked debris, which the next release then reported as
# "uncommitted changes" — noise that looks like a real problem mid-release.
	@trap 'rm -f sea-entry.cjs sea-config.json sea.blob qunitx-sea' INT TERM HUP; \
	NODE_PLATFORM=$$(node -p "process.platform"); \
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
	$(MAKE) smoke-sea TARGET=$$TARGET || { rm -f sea-entry.cjs sea-config.json sea.blob qunitx-sea; exit 1; }; \
	VERSION=$$(node -p 'require("./package.json").version'); \
	node scripts/set-pkg-version.js npm/$$TARGET/package.json $$VERSION; \
	npm publish ./npm/$$TARGET --access public; \
	rm -f sea-entry.cjs sea-config.json sea.blob qunitx-sea

# Everything that answers in seconds. Split out so `release` can run it before the minutes-long
# gates: a formatting slip should not cost a bench run and two full suites to discover.
check-static: format lint lint-docs bench-typecheck

check: check-static test

coverage:
	npx c8 --reporter=lcov --reporter=text --reporter=html npm test

coverage-report:
	npx c8 --reporter=lcov --reporter=text --reporter=html --open npm test

# Regenerate docs/demo.gif (composite terminal + browser GIF).
# Requires: nix (for vhs, ffmpeg, gifsicle), CHROME_BIN set or Nix-resolved chromium.
demo:
	bash docs/make-demo-gif.sh

dev:
	npm run dev

docs:
	npm run docs

fix:
	npm run format:fix

fmt:
	npm run format:fix

format:
	npm run format

help:
	@echo "Usage: make <target> [LEVEL=patch|minor|major] [REGRESSION_THRESHOLD=26]"
	@echo ""
	@echo "  bench           Run all benchmarks and save results as new baseline"
	@echo "  bench-check     Run benchmarks and fail if regression > REGRESSION_THRESHOLD%"
	@echo "  bench-print     Run all benchmarks (display only, no save)"
	@echo "  bench-typecheck Type-check benchmark files (catches Node-globals leaks under Deno)"
	@echo "  bench-update    Alias for bench"
	@echo "  build           Build the project"
	@echo "  build-deno      Build a Deno-compiled binary for the local platform into dist/qunitx"
	@echo "  build-deno-all  Cross-compile Deno binaries for linux/macos/windows × x64/arm64"
	@echo "  build-sea       Build SEA binary for the local platform and publish its npm package"
	@echo "  check           Format + lint + bench-typecheck + tests"
	@echo "  coverage        Run tests with coverage report"
	@echo "  demo            Regenerate docs/demo.gif"
	@echo "  dev             Watch all tests with --debug (for development)"
	@echo "  fix             Auto-fix formatting"
	@echo "  format          Check formatting (prettier)"
	@echo "  lint            Check code quality (deno lint)"
	@echo "  release         Bump version, update changelog, tag, push, publish to npm"
	@echo "  smoke-deno      Smoke-test the locally-built Deno binary (~10s)"
	@echo "  smoke-sea       Smoke-test the locally-built SEA binary (~10s; runs inside build-sea)"
	@echo "  test            Run full test suite (chromium)"
	@echo "  test-all-browsers Run full suite on chromium, then browser tests on firefox + webkit"
	@echo "  test-chrome     Alias for test"
	@echo "  test-debug      Run full test suite with --debug on all qunitx invocations"
	@echo "  test-firefox    Run browser tests with Firefox (requires: npx playwright install firefox)"
	@echo "  test-release    Build, pack, install tarball, run full suite against the binary"
	@echo "  test-webkit     Run browser tests with WebKit (requires: npx playwright install webkit)"
	@echo "  vendor          Regenerate the embedded qunitx runtime + qunit.css (run after bumping qunitx)"
	@echo ""
	@echo "Env-var escape hatches:"
	@echo "  SKIP_BENCHMARK=true                       skip bench-check entirely (e.g. SKIP_BENCHMARK=true make release)"
	@echo "  SKIP_BENCHMARK=<file>[,<file>...]         skip specific bench files by basename, e.g. SKIP_BENCHMARK=e2e,tap"

lint:
	npm run lint

lint-docs:
	npm run lint:docs

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
# A release rewrites the working tree — version bumps across seven files, regenerated vendor
# assets, a commit and a tag — over roughly twenty minutes. Anything else touching the tree in
# that window corrupts it silently: a `git checkout` of package.json mid-run reverted a bump
# between `npm version` and `npm publish`, so the publish announced the PREVIOUS version and npm
# rejected it, after the SEA package for the new one had already gone out.
#
# The lock records the pid so a crashed release does not wedge the next one: a stale lock whose
# owner is gone is reclaimed, a live one refuses. Removed on exit, success or failure, via trap.
	@mkdir -p tmp; \
	if [ -f tmp/.release-lock ]; then \
		owner=$$(cat tmp/.release-lock 2>/dev/null); \
		if [ -n "$$owner" ] && kill -0 "$$owner" 2>/dev/null; then \
			echo "a release is already running (pid $$owner)."; \
			echo "wait for it, or remove tmp/.release-lock if you are sure it is dead."; \
			exit 1; \
		fi; \
		echo "reclaiming a stale release lock from dead pid $$owner"; \
	fi; \
	echo $$PPID > tmp/.release-lock
# The branch gate, first and non-negotiable. `npm publish` runs BEFORE the commit and tag below,
# so a release started on a topic branch ships THAT branch's code to npm — under a version main
# never contained — and the bare `git push` at the end pushes the topic branch, leaving the tag
# on a commit that is not in main. Both happen silently. v0.32.0 shipped the whole unmerged PR
# stack this way.
	@branch=$$(git rev-parse --abbrev-ref HEAD); \
	if [ "$$branch" != "main" ]; then \
		echo "make release must run on main — you are on '$$branch'."; \
		echo "npm publish happens before the release commit, so this would publish '$$branch'."; \
		exit 1; \
	fi
	@git fetch -q origin main; \
	if [ "$$(git rev-parse HEAD)" != "$$(git rev-parse origin/main)" ]; then \
		echo "main and origin/main differ — pull or push first, then release."; \
		exit 1; \
	fi
# Fail here, not after ~10 minutes of vendor + bench + check + test:release, when the version the
# bump would produce is already on npm — which `npm publish` rejects outright.
	@name=$$(node -p "require('./package.json').name"); \
	target=$$(node -p "const [a,b,c]=require('./package.json').version.split('.').map(Number); \
		({patch:[a,b,c+1],minor:[a,b+1,0],major:[a+1,0,0]}['$(LEVEL)']||'$(LEVEL)'.split('.')).join('.')"); \
	if npm view "$$name@$$target" version > /dev/null 2>&1; then \
		echo "$$name@$$target is already published — pick the next free version, e.g. LEVEL=<x.y.z>."; \
		exit 1; \
	fi; \
	echo "releasing $$name@$$target from main"
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "WARNING: Uncommitted changes detected — these will NOT be included in the release:"; \
		git status --short; \
		echo ""; \
	fi
# esbuild refuses to start when its JS host and its native binary disagree on version, and
# `npm audit fix` can bump the host while leaving the optional platform package stale on disk.
# `npm ci` never reproduces that skew, so CI stays green and the only thing that notices is
# build-sea — twenty minutes in, past the full suite, as `The service was stopped: write EPIPE`.
# Detectable here in milliseconds instead.
	@host=$$(node -p "require('esbuild/package.json').version"); \
	target=$$(node -p "process.platform + '-' + process.arch"); \
	binary=$$(node -p "require('@esbuild/$$target/package.json').version" 2>/dev/null || echo "not installed"); \
	if [ "$$host" != "$$binary" ]; then \
		echo "esbuild is out of sync: host $$host, @esbuild/$$target $$binary."; \
		echo "Run 'npm install' to match node_modules to the lockfile, then retry."; \
		exit 1; \
	fi
	@eval $$(ssh-agent -s); trap "ssh-agent -k > /dev/null" EXIT; ssh-add
	@npm whoami > /dev/null 2>&1 || npm login
	@echo "npm user: $$(npm whoami) | $$(date '+%Y-%m-%d %H:%M:%S %Z')"
# Regenerate the embedded qunitx runtime + qunit.css from the installed qunitx BEFORE checks / build /
# publish, so every release ships vendored assets matching package.json's qunitx. The freshness test
# in `check` then validates them, and they are committed with the release commit below.
# A clean install, before anything reads node_modules. Releases are cut from a long-lived working
# tree; CI runs on a pristine one — and every release failure so far has lived in that gap. An
# `npm audit fix` left esbuild's host at 0.28.2 against a 0.28.1 binary; `deno install` accumulated
# qunitx 1.2.18 beside 1.2.19 and `make vendor` bundled the older one. The lockfile was right both
# times, so CI never reproduced either. Three seconds buys the whole class.
	npm ci
# A daemon left running for this cwd serves runs from a warm browser and a cached bundle, so the
# suite exercises whatever that daemon was built from rather than the tree being released. One
# already survived across sessions here and silently changed what an ad-hoc run tested.
	@node cli.ts daemon stop > /dev/null 2>&1 || true
# Cheapest first, so a release fails in seconds rather than twenty minutes. The esbuild guard now
# also serves as an assertion that the install above produced a coherent tree.
	$(MAKE) check-static
	$(MAKE) vendor
	$(MAKE) bench-check
	$(MAKE) test
	npm run test:release
	npm version $(LEVEL) --no-git-tag-version
	@for d in npm/*/; do node scripts/set-pkg-version.js "$$d/package.json" "$$(node -p 'require("./package.json").version')"; done
	@node scripts/set-pkg-version.js jsr/deno.json "$$(node -p 'require("./package.json").version')"
# The JSR publish is CI's job (provenance needs the Actions OIDC token), but its failure modes are
# all reachable from here — resolution, type-check, the staged tree. v0.34.5 published to npm and
# GitHub, then the tag's publish-jsr died resolving a devDependency deno considered too young, and
# the version existed everywhere except JSR. Dry-running before `npm publish` makes that a release
# that never started rather than one that half-finished.
	node scripts/stage-jsr-library.ts
	cd jsr && deno publish --dry-run --allow-dirty
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
# JSR is NOT published here. The `publish-jsr` job in ci.yml does it when the tag lands, so the
# release carries provenance — `deno publish` needs the Actions OIDC token to mint a transparency
# log entry, which a laptop cannot produce. jsr/deno.json's version is bumped and committed above;
# CI stages lib/, templates/ and package.json into jsr/ and publishes from the tag.
#
# The trade: npm is live the moment this recipe finishes, JSR a few minutes later when CI reaches
# the tag. If that job fails, the version exists on npm but not JSR — re-run the job rather than
# re-tagging.
	@node scripts/remove-optional-deps.js
	@npm install --package-lock-only --ignore-scripts
	git-cliff --tag "v$$(node -p 'require("./package.json").version')" --output CHANGELOG.md
	git add package.json package-lock.json CHANGELOG.md npm/*/package.json jsr/deno.json templates/vendor
	git commit -m "Release $$(node -p 'require("./package.json").version')"
	git tag "v$$(node -p 'require("./package.json").version')"
# Explicit remote and ref, not a bare `git push`: a bare push follows the current branch, which is
# how a release can land on something other than main. The branch gate above makes that
# unreachable, and naming main here means the two would have to disagree for it to happen again.
	git push origin main && git push origin "v$$(node -p 'require("./package.json").version')"
	@rm -f tmp/.release-lock
	$(MAKE) bench

# Smoke-tests the locally-built dist/qunitx Deno binary against the same fixtures
# as smoke-sea. Mirrors that target's failure surface (run path, daemon control,
# end-to-end Chrome run) without re-running the full suite. Requires that
# `make build-deno` has been run first.
smoke-deno:
	@SEA=$(CURDIR)/dist/qunitx; \
	if [ ! -x "$$SEA" ]; then echo "smoke-deno: $$SEA not found (run make build-deno first)" >&2; exit 1; fi; \
	echo "Smoking Deno binary at $$SEA..."; \
	OUT=tmp/deno-smoke-$$$$; FAIL=0; \
	"$$SEA" --version >/dev/null                                                      || { echo "  ✗ --version" >&2; FAIL=1; }; \
	"$$SEA" daemon 2>&1 | grep -q "Usage: qunitx daemon"                              || { echo "  ✗ daemon (no args)" >&2; FAIL=1; }; \
	QUNITX_NO_DAEMON=1 "$$SEA" test/fixtures/passing-tests.ts --output=$$OUT 2>&1 | grep -q "# pass 3" \
	                                                                                  || { echo "  ✗ run path" >&2; FAIL=1; }; \
	rm -rf $$OUT; \
	if [ $$FAIL -ne 0 ]; then echo "smoke-deno: FAILED" >&2; exit 1; fi; \
	echo "smoke-deno: OK"

# Focused smoke test for the SEA binary at npm/$(TARGET)/bin/qunitx.
# Catches the SEA-specific failure surface (CJS module-load crashes, asset
# loading via node:sea, daemon respawn path, esbuild sidecar discovery, end-to-end
# Chrome run) in ~10 seconds — without re-running the full 2:41 npm test suite
# that already covers source (make check) and bundled JS (test:release).
# TARGET is auto-detected from the host platform when not passed in.
smoke-sea:
	@TARGET="$(TARGET)"; \
	if [ -z "$$TARGET" ]; then \
	  NODE_PLATFORM=$$(node -p "process.platform"); NODE_ARCH=$$(node -p "process.arch"); \
	  if [ "$$NODE_PLATFORM" = "darwin" ]; then TARGET="darwin-$$NODE_ARCH"; \
	  elif [ "$$NODE_PLATFORM" = "linux" ]; then TARGET="linux-$$NODE_ARCH"; \
	  else echo "smoke-sea: unsupported platform $$NODE_PLATFORM-$$NODE_ARCH" >&2; exit 1; fi; \
	fi; \
	SEA=$$(pwd)/npm/$$TARGET/bin/qunitx; \
	ESBUILD=$$(pwd)/node_modules/@esbuild/$$TARGET/bin/esbuild; \
	if [ ! -x "$$SEA" ]; then echo "smoke-sea: $$SEA not found (run make build-sea first)" >&2; exit 1; fi; \
	echo "Smoking SEA binary at $$SEA..."; \
	OUT=tmp/sea-smoke-$$$$; FAIL=0; \
	"$$SEA" --version >/dev/null                                                      || { echo "  ✗ --version" >&2; FAIL=1; }; \
	"$$SEA" daemon 2>&1 | grep -q "Usage: qunitx daemon"                              || { echo "  ✗ daemon (no args)" >&2; FAIL=1; }; \
	ESBUILD_BINARY_PATH=$$ESBUILD "$$SEA" daemon start >/dev/null                     || { echo "  ✗ daemon start" >&2; FAIL=1; }; \
	"$$SEA" daemon stop >/dev/null                                                    || { echo "  ✗ daemon stop" >&2; FAIL=1; }; \
	ESBUILD_BINARY_PATH=$$ESBUILD "$$SEA" test/fixtures/passing-tests.ts --output=$$OUT --no-daemon 2>&1 | grep -q "# pass 3" \
	                                                                                  || { echo "  ✗ run path" >&2; FAIL=1; }; \
	rm -rf $$OUT; \
	"$$SEA" daemon stop >/dev/null 2>&1 || true; \
	if [ $$FAIL -ne 0 ]; then echo "smoke-sea: FAILED" >&2; exit 1; fi; \
	echo "smoke-sea: OK"

test:
	npm test

test-all-browsers: test test-firefox test-webkit

test-chrome: test

test-debug:
	npm run test:debug

test-firefox:
	QUNITX_BROWSER=firefox npm run test:browser

test-release:
	bash scripts/test-release.sh

test-webkit:
	QUNITX_BROWSER=webkit npm run test:browser

# Regenerates templates/vendor/{qunitx-runtime.js,qunit.css} from the installed qunitx
# devDependency. Run after bumping qunitx in package.json, then commit the outputs — they are
# embedded into every distribution (npm/SEA/deno) so consumers need no `npm install qunitx`.
vendor:
	node scripts/write-vendor-runtime.ts
