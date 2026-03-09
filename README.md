# qunitx-cli

[![CI](https://github.com/izelnakri/qunitx-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/izelnakri/qunitx-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/qunitx-cli)](https://www.npmjs.com/package/qunitx-cli)
[![npm downloads](https://img.shields.io/npm/dm/qunitx-cli)](https://www.npmjs.com/package/qunitx-cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Browser-based test runner for [QUnitX](https://github.com/izelnakri/qunitx) — bundles your JS/TS tests
with esbuild, runs them in headless Chrome, and streams TAP output to the terminal.

![qunitx-cli demo](demo/demo.gif)

## Features

- Runs `.js` and `.ts` test files in headless Chrome (Puppeteer + esbuild)
- TypeScript works with zero configuration — esbuild handles transpilation
- Inline source maps for accurate stack traces pointing to original source files
- Streams TAP-formatted output to the terminal in real time
- `--watch` mode re-runs affected tests on file change
- `--failFast` stops the run after the first failing test
- `--debug` prints the local server URL and pipes browser console to stdout
- `--before` / `--after` hook scripts for server setup and teardown
- `--timeout` controls the maximum ms to wait for the full suite to finish
- Docker image for zero-install CI usage

## Installation

```sh
npm install --save-dev qunitx-cli
```

Or run without installing:

```sh
npx qunitx test/**/*.js
```

With Docker — no install needed:

```sh
docker run --rm -v "$(pwd):/code" -w /code ghcr.io/izelnakri/qunitx-cli:latest npx qunitx test/**/*.js
```

With Nix:

```sh
nix profile install github:izelnakri/qunitx-cli
```

## Usage

```sh
# Single file
qunitx test/my-test.js

# Multiple files / globs
qunitx test/**/*.js test/**/*.ts

# TypeScript — no tsconfig required
qunitx test/my-test.ts

# Watch mode: re-run on file changes
qunitx test/**/*.js --watch

# Stop on the first failure
qunitx test/**/*.js --failFast

# Print the server URL and pipe Chrome console to stdout
qunitx test/**/*.js --debug

# Custom timeout (ms)
qunitx test/**/*.js --timeout=30000

# Run a setup script before tests (can be async — awaited automatically)
qunitx test/**/*.js --before=scripts/start-server.js

# Run a teardown script after tests (can be async)
qunitx test/**/*.js --after=scripts/stop-server.js
```

## Writing Tests

qunitx-cli runs [QUnitX](https://github.com/izelnakri/qunitx) tests — a superset of QUnit with async
hooks, concurrency control, and test metadata.

Migrating from QUnit? Change a single import:

```js
// before
import { module, test } from 'qunit';
// after
import { module, test } from 'qunitx';
```

Example test file — ES modules, npm imports, and nested modules all work out of the box:

```js
// some-test.js (TypeScript is also supported)
import { module, test } from 'qunitx';
import $ from 'jquery';

module('Basic sanity check', (hooks) => {
  test('it works', (assert) => {
    assert.equal(true, true);
  });

  module('More advanced cases', (hooks) => {
    test('deepEqual works', (assert) => {
      assert.deepEqual({ username: 'izelnakri' }, { username: 'izelnakri' });
    });

    test('can import ES & npm modules', (assert) => {
      assert.ok(Object.keys($));
    });
  });
});
```

Run it:

```sh
# Headless Chrome (recommended for CI)
qunitx some-test.js

# With browser console output
qunitx some-test.js --debug

# TypeScript — no config needed
qunitx some-test.ts
```

## CLI Reference

```
Usage: qunitx [files/folders...] [options]

Options:
  --watch             Re-run tests on file changes
  --failFast          Stop after the first failure
  --debug             Print the server URL; pipe browser console to stdout
  --timeout=<ms>      Max ms to wait for the suite to finish  [default: 10000]
  --output=<dir>      Directory for compiled test assets     [default: ./tmp]
  --before=<file>     Script to run (and optionally await) before tests start
  --after=<file>      Script to run (and optionally await) after tests finish
  --port=<n>          HTTP server port (auto-selects a free port if taken)
```

## Development

```sh
npm install
make check                 # lint + test (run before every commit)
make test                  # run tests only
make demo                  # regenerate demo output
make release LEVEL=patch   # bump version, update changelog, tag, push
```

## License

MIT
