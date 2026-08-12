#!/usr/bin/env bash
# Packs the built artefact, installs it into a throwaway directory, and runs
# the full test suite with QUNITX_BIN pointing at the installed binary.
#
# This verifies the published package works end-to-end when installed by a
# downstream user — catching packaging bugs that source tests cannot see
# (missing dist/ files, broken bin wrapper, wrong exports map, etc.).
#
# Usage: bash scripts/test-release.sh
#   (run from the repo root; Chrome must be available in PATH or via CHROME_BIN)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CONSUMER=$(mktemp -d)
trap 'rm -rf "$CONSUMER"' EXIT

# Build dist/ so the packed tarball contains the latest JS bundle.
cd "$ROOT"
npm run build

# Pack into the throwaway directory.
npm pack --pack-destination "$CONSUMER" --quiet 2>/dev/null
TARBALL=$(ls "$CONSUMER"/*.tgz | head -1)

# Install the tarball to get the `qunitx` bin script in a local node_modules.
cd "$CONSUMER"
printf '{"type":"module"}' > package.json
npm install --no-save --quiet "$TARBALL"

# On Unix the .bin/ shell wrapper is a real executable; spawn() works fine.
# On Windows (Git Bash / MSYS2) spawn() cannot execute shell wrapper scripts —
# shell.ts detects the .js extension and invokes it as `node QUNITX_BIN`.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    QUNITX_BIN="$CONSUMER/node_modules/qunitx-cli/bin/qunitx.js"
    ;;
  *)
    QUNITX_BIN="$CONSUMER/node_modules/.bin/qunitx"
    ;;
esac
echo "test-release: running full test suite with QUNITX_BIN=$QUNITX_BIN"

# The local install above is not the shape end users have: it puts playwright-core, esbuild and ws
# into the consumer's own node_modules, so anything resolving from the CWD succeeds by accident.
# A global install into a project with no node_modules is the shape that broke in 0.34.0.
#
# Note what this does NOT cover. The 0.34.0 failure needed the optional SEA package, and npm skips
# those for a version that is not on the registry yet — which is exactly when this script runs, so
# the SEA path stays unexercised here no matter what. `test/bin/sea-support-test.ts` pins the guard
# that decides it. What this catches is everything else about a global install: the bin wrapper,
# the exports map, and dist/cli.js resolving its own dependencies rather than the caller's.
GLOBAL_PREFIX="$CONSUMER/global"
BARE=$(mktemp -d)
trap 'rm -rf "$CONSUMER" "$BARE"' EXIT

npm install --global --prefix "$GLOBAL_PREFIX" --quiet "$TARBALL"
cd "$BARE"
printf '{"name":"bare","version":"1.0.0","type":"module"}' > package.json
printf "import { module, test } from 'qunitx';\nmodule('Bare', () => { test('runs', (assert) => assert.ok(true)); });\n" > bare-test.js

# npm puts global shims in `<prefix>/bin` on POSIX but directly in `<prefix>` on Windows, so the
# shim is searched for rather than assumed — hardcoding `bin/` failed every Windows run with a bare
# `qunitx: command not found`, which says nothing about which of the two layouts was there.
GLOBAL_QUNITX=""
for candidate in "$GLOBAL_PREFIX/bin/qunitx" "$GLOBAL_PREFIX/qunitx"; do
  if [ -f "$candidate" ]; then
    GLOBAL_QUNITX="$candidate"
    break
  fi
done
if [ -z "$GLOBAL_QUNITX" ]; then
  echo "test-release: no global qunitx shim under $GLOBAL_PREFIX — npm's layout changed:" >&2
  ls -R "$GLOBAL_PREFIX" >&2
  exit 1
fi

echo "test-release: running a globally-installed qunitx in a project with no node_modules"
"$GLOBAL_QUNITX" bare-test.js
cd "$ROOT"

# Run the test suite from the source root so test fixtures are reachable,
# but with QUNITX_BIN set so every `node cli.ts` invocation uses the binary.
# TEST_SCRIPT defaults to 'test' (full suite on chromium).
# Set TEST_SCRIPT=test:browser for firefox/webkit runs that only need the
# browser-specific subset — matches the browser-compat CI pattern.
cd "$ROOT"
QUNITX_BIN="$QUNITX_BIN" npm run "${TEST_SCRIPT:-test}"
