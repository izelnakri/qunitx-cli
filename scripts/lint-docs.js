#!/usr/bin/env node
// NOTE FOR MAINTAINERS (humans and LLMs): revisit this file on every deno upgrade.
// Filters below may become unnecessary as deno fixes regressions — remove them when
// the underlying deno bug is fixed so the full lint runs clean without any filter.
//
// This script runs `deno doc --lint` and fails only on errors that represent
// real documentation quality issues, filtering noise introduced by TypeScript migration:
//
// Filtered error types:
// - `missing-return-type`: deno 2.7.x regression — JSDoc @returns is ignored; TS return
//   type annotations now satisfy this check but older deno versions still flag them.
// - `missing-explicit-type`: false positive for complex TypeScript expressions.
// - `private-type-ref`: fires when public symbols reference types from external npm packages
//   (Browser/Page from playwright-core, WebSocketServer from ws). These can't be fixed
//   without re-exporting third-party types, which would bloat the public API.
import { spawn } from 'node:child_process';

// Doctests, Rust-style: `deno check --doc` type-checks every ```ts block in these files'
// JSDoc, so an example that drifts from the API stops the build. Every block must be
// self-contained (imports + `declare const` for the values an example assumes; the
// documented module's own exports are auto-imported). Illustrative fragments that should
// not be checked use a ```ts ignore fence.
//
// CACHE FOOTGUN: deno's type-check cache is content-keyed but (as of 2.9) not keyed on
// --doc, so an unchanged file that previously passed a plain `deno check` silently skips
// its doc blocks here. CI is always cold; locally, touch the file to re-verify it.
const DOCTESTED = ['lib/result/', 'lib/task/'];

/** Runs a command, collecting interleaved stdout+stderr — non-blocking, so the doctest
 *  check and the doc lint below run concurrently. */
function run(command, args) {
  return new Promise((resolve) => {
    const proc = spawn(command, args);
    let output = '';
    proc.stdout.on('data', (chunk) => (output += chunk));
    proc.stderr.on('data', (chunk) => (output += chunk));
    proc.on('close', (code) => resolve({ code, output }));
  });
}

const [doctests, docLint] = await Promise.all([
  run('deno', ['check', '--doc', ...DOCTESTED]),
  run('deno', ['doc', '--lint', '--quiet', 'lib/', 'cli.ts']),
]);

if (doctests.code !== 0) {
  process.stderr.write(doctests.output);
  process.exitCode = 1;
}

// Strip ANSI escape codes so we can match on plain text. \x1b is the ESC byte —
// intentionally a control character, deno-lint rule no-control-regex doesn't apply.
// deno-lint-ignore no-control-regex
const plain = docLint.output.replace(/\x1b\[[0-9;]*m/g, '');

// Split into per-error blocks (each block starts with "error[") and drop the noise
// documented in the header note.
const blocks = plain.split(/(?=^error\[)/m);
const relevant = blocks.filter(
  (b) =>
    !b.startsWith('error[missing-return-type]') &&
    !b.startsWith('error[missing-explicit-type]') &&
    !b.startsWith('error[private-type-ref]'),
);
const result = relevant.join('').trim();

if (result.includes('error[')) {
  process.stderr.write(result + '\n');
  process.exitCode = 1;
} else if (result) {
  process.stdout.write(result + '\n');
}
