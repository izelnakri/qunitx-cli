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

const proc = spawn('deno', ['doc', '--lint', '--quiet', 'lib/', 'cli.ts'], { encoding: 'utf8' });
let output = '';
proc.stdout.on('data', (chunk) => (output += chunk));
proc.stderr.on('data', (chunk) => (output += chunk));
proc.on('close', () => {
  // Strip ANSI escape codes so we can match on plain text
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');

  // Split into per-error blocks (each block starts with "error[")
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
    process.exit(1);
  } else if (result) {
    process.stdout.write(result + '\n');
  }
});
