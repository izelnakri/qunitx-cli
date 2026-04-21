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

# Run the test suite from the source root so test fixtures are reachable,
# but with QUNITX_BIN set so every `node cli.ts` invocation uses the binary.
# TEST_SCRIPT defaults to 'test' (full suite on chromium).
# Set TEST_SCRIPT=test:browser for firefox/webkit runs that only need the
# browser-specific subset — matches the browser-compat CI pattern.
cd "$ROOT"
QUNITX_BIN="$QUNITX_BIN" npm run "${TEST_SCRIPT:-test}"
