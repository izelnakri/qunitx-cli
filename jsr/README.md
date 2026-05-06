# @izelnakri/qunitx-cli

JSR bootstrap for [qunitx-cli](https://github.com/izelnakri/qunitx-cli) — a
browser-based QUnit test runner. Resolves the matching prebuilt binary from
GitHub Releases on first run, caches it under `~/.cache/qunitx/<version>/`,
and spawns it.

## Install

```sh
deno install -Agf jsr:@izelnakri/qunitx-cli
```

That registers a `qunitx-cli` launcher in `$DENO_INSTALL_ROOT/bin`. First
invocation downloads the prebuilt binary (~190 MB compressed); every
subsequent invocation skips straight to spawning the cached binary.

## Why

`deno run jsr:@izelnakri/qunitx-cli/cli.ts` would re-evaluate the source
graph each run, which is slower than the prebuilt `deno compile`d binary.
This bootstrap gives Deno-only users the binary's fast-start path without
asking them to download and unpack a tarball manually.

For the same effect via shell (no Deno required):

```sh
curl -fsSL https://raw.githubusercontent.com/izelnakri/qunitx-cli/main/install.sh | sh
```

## Supported targets

linux-x64, macos-arm64, windows-x64 — same matrix as the [GitHub
Releases](https://github.com/izelnakri/qunitx-cli/releases). Unsupported
platform/arch combos exit non-zero with a clear message.
