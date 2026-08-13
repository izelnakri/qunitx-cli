#!/usr/bin/env bash
# Installs the packed artefact GLOBALLY and runs it in a project with no node_modules — the shape
# an end user actually has, and the one three shipped bugs lived in:
#
#   * the SEA resolving `playwright-core` against the CWD (0.34.0)
#   * the static output copying a qunit.css only a local install would have (0.34.1)
#   * this script's own shim lookup assuming npm's POSIX layout (0.34.1)
#
# `scripts/test-release.sh` installs the tarball LOCALLY, which drops the runner's dependencies
# into the consumer's own node_modules and makes anything resolving from the CWD succeed by
# accident — so none of the three were visible there. Split out from that script so CI can run it
# on its own: it needs no browser matrix and no test suite, just a real install and one real run.
#
# Usage: bash scripts/test-global-install.sh
#   (run from the repo root; Chrome must be available in PATH or via CHROME_BIN)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
BARE=$(mktemp -d)
trap 'rm -rf "$WORK" "$BARE"' EXIT

cd "$ROOT"
npm run build
npm pack --pack-destination "$WORK" --quiet 2>/dev/null
TARBALL=$(ls "$WORK"/*.tgz | head -1)

GLOBAL_PREFIX="$WORK/global"
npm install --global --prefix "$GLOBAL_PREFIX" --quiet "$TARBALL"

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
  echo "test-global-install: no global qunitx shim under $GLOBAL_PREFIX — npm's layout changed:" >&2
  ls -R "$GLOBAL_PREFIX" >&2
  exit 1
fi

# The scaffolding commands first, because `init` writes the page whose asset references broke the
# run in 0.34.1 — going straight to a hand-written test file would skip the case entirely.
cd "$BARE"
printf '{"name":"bare-project","version":"1.0.0"}' > package.json

echo "test-global-install: qunitx init"
"$GLOBAL_QUNITX" init

echo "test-global-install: qunitx new some-test.js"
"$GLOBAL_QUNITX" new some-test.js

echo "test-global-install: running the generated test with no node_modules in the project"
"$GLOBAL_QUNITX" some-test.js | tee run.tap

# The exit code alone is not enough: assert on the TAP body, because the failures this script
# exists to catch all happened mid-run. `qunitx new` scaffolds exactly two tests.
if ! grep -qx '# pass 2' run.tap || ! grep -qx '# fail 0' run.tap; then
  echo "test-global-install: expected the scaffolded suite to report 2 passing tests" >&2
  exit 1
fi

echo "test-global-install: OK"
