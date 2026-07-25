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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Doctests, Rust-style, live in `npm run typecheck` (`deno check --doc lib/ cli.ts`), which
// type-checks every ```ts/```js block in JSDoc across the whole public API: an example that
// drifts stops the build. Every block must be self-contained (imports + `declare const` for
// the values it assumes; the documented module's own exports are auto-imported), and a
// ```ts ignore fence opts a fragment out. One reporting quirk: a SYNTAX error in any block
// aborts the whole invocation, masking other files' type errors until it is fixed — the
// exit code still fails either way. (An earlier note here claimed deno's check cache could
// silently skip doc blocks after a plain check; a controlled test disproved that.)
//
// The canary below is this gate's self-test: a deliberately broken example must FAIL under
// --doc. If it ever passes — a deno upgrade changed block extraction, or the flag moved —
// the doctest gate is green-while-dead, and this script says so instead of staying quiet.

/** Runs a command, collecting interleaved stdout+stderr — non-blocking, so the canary and
 *  the doc lint below run concurrently. */
function run(command, args) {
  return new Promise((resolve) => {
    const proc = spawn(command, args);
    let output = '';
    proc.stdout.on('data', (chunk) => (output += chunk));
    proc.stderr.on('data', (chunk) => (output += chunk));
    proc.on('close', (code) => resolve({ code, output }));
  });
}

async function doctestGateIsAlive() {
  const dir = await mkdtemp(path.join(tmpdir(), 'qunitx-doctest-canary-'));
  try {
    const canary = path.join(dir, 'canary.ts');
    await writeFile(
      canary,
      '/**\n * ```ts\n * const broken: number = "must fail the doc check";\n * ```\n */\nexport const canary = 1;\n',
    );
    const { code } = await run('deno', ['check', '--doc', canary]);
    return code !== 0; // the broken block MUST fail; a pass means blocks are not being checked
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const [gateAlive, docLint] = await Promise.all([
  doctestGateIsAlive(),
  run('deno', ['doc', '--lint', '--quiet', 'lib/', 'cli.ts']),
]);

if (!gateAlive) {
  process.stderr.write(
    'doctest canary: `deno check --doc` accepted a deliberately broken JSDoc example — ' +
      'the doctest gate (npm run typecheck) is no longer checking doc blocks.\n',
  );
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
