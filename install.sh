#!/usr/bin/env sh
# qunitx-cli installer — downloads the latest standalone binary + esbuild
# sidecar from GitHub Releases and unpacks them into $INSTALL_DIR (default
# ~/.qunitx). Idiomatic curl-pipe-sh install with no runtime prerequisite
# beyond `curl`, `tar` (or `unzip` on Windows), and a system Chrome on PATH.
#
# Quick install:
#   curl -fsSL https://raw.githubusercontent.com/izelnakri/qunitx-cli/main/install.sh | sh
#
# Override version or location:
#   VERSION=v0.25.0 INSTALL_DIR=$HOME/.local/bin sh install.sh
#
# Supported platforms: linux x64/arm64 (glibc or musl), macOS arm64, and
# Windows x64/arm64 (Git Bash / MSYS2). Other targets exit 1 with a message
# rather than installing a wrong binary.

set -eu

REPO="izelnakri/qunitx-cli"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.qunitx}"
VERSION="${VERSION:-}"

case "$(uname -s)" in
  Linux*)               OS=linux ;;
  Darwin*)              OS=macos ;;
  MINGW*|MSYS*|CYGWIN*) OS=windows ;;
  *) echo "qunitx-cli installer: unsupported OS '$(uname -s)'" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64)   ARCH=x64 ;;
  arm64|aarch64)  ARCH=arm64 ;;
  *) echo "qunitx-cli installer: unsupported arch '$(uname -m)'" >&2; exit 1 ;;
esac

# A shell under Rosetta reports x86_64 on Apple silicon; the native build is the one to install.
if [ "$OS" = "macos" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
  ARCH=arm64
fi

TARGET="${OS}-${ARCH}"
case "$TARGET" in
  linux-x64|linux-arm64|macos-arm64|windows-x64|windows-arm64) ;;
  *) echo "qunitx-cli installer: no prebuilt binary published for $TARGET" >&2; exit 1 ;;
esac

# The deno binary links glibc, and a musl system (Alpine) cannot start it — not even with gcompat.
# There the musl build is installed instead: a directory (the binary, the libraries bare Alpine
# lacks, the esbuild sidecar, playwright-core), kept in its own subdirectory with `qunitx` linked
# to it, so none of that lands loose in a shared directory like ~/.local/bin.
ASSET="qunitx-deno-$TARGET"
MUSL=""
if [ "$OS" = "linux" ] && { ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; }; then
  ASSET="qunitx-$TARGET-musl"
  MUSL=1
fi

# Resolve the version: default is the GitHub `latest` release pointer. Done via
# the public API (no auth required for public repos, 60 unauthenticated requests
# per IP per hour — fine for one-shot installs).
if [ -z "$VERSION" ]; then
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
  if [ -z "$VERSION" ]; then
    echo "qunitx-cli installer: failed to resolve latest release; pass VERSION=vX.Y.Z" >&2
    exit 1
  fi
fi

EXT=tar.gz
if [ "$OS" = "windows" ]; then EXT=zip; fi

URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET.$EXT"
echo "qunitx-cli installer: $VERSION → $INSTALL_DIR"
echo "  fetching $URL"

mkdir -p "$INSTALL_DIR"
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t qunitx)
# shellcheck disable=SC2064
trap "rm -rf '$TMP'" EXIT

curl -fsSL "$URL" -o "$TMP/qunitx.$EXT"

if [ "$EXT" = "zip" ]; then
  unzip -q "$TMP/qunitx.$EXT" -d "$TMP"
else
  tar xzf "$TMP/qunitx.$EXT" -C "$TMP"
fi

# Release tarball layout: <asset>/{qunitx[.exe], esbuild[.exe]}, plus lib/ and node_modules/ for musl.
SRC="$TMP/$ASSET"
if [ -n "$MUSL" ]; then
  rm -rf "$INSTALL_DIR/qunitx-musl"
  cp -R "$SRC" "$INSTALL_DIR/qunitx-musl"
  chmod +x "$INSTALL_DIR/qunitx-musl/qunitx" "$INSTALL_DIR/qunitx-musl/esbuild"
  ln -sf qunitx-musl/qunitx "$INSTALL_DIR/qunitx"
elif [ "$OS" = "windows" ]; then
  cp "$SRC/qunitx.exe"  "$INSTALL_DIR/qunitx.exe"
  cp "$SRC/esbuild.exe" "$INSTALL_DIR/esbuild.exe"
else
  # Unlinked first: over a musl install this is a symlink, and cp would write through it.
  rm -f "$INSTALL_DIR/qunitx"
  cp "$SRC/qunitx"  "$INSTALL_DIR/qunitx"
  cp "$SRC/esbuild" "$INSTALL_DIR/esbuild"
  chmod +x "$INSTALL_DIR/qunitx" "$INSTALL_DIR/esbuild"
fi

echo ""
echo "qunitx-cli $VERSION installed to $INSTALL_DIR"
echo ""

# PATH hint — only print when INSTALL_DIR is not already on PATH so users who
# already configured it (e.g. on re-install) don't get noisy reminders.
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "Add to your shell rc to make 'qunitx' callable from anywhere:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    echo ""
    ;;
esac
