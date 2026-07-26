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

// Doctests, Rust-style, live in two gates: `npm run typecheck` (`deno check --doc`)
// type-checks every ```ts/```js block in JSDoc across the whole public API, and
// `npm run test:doctest` (`deno test --doc`) RUNS them under a near-zero-permission
// sandbox. Every block must be self-contained with real stub values — `deno test --doc`
// wraps blocks in a test function, where `declare` headers are illegal (TS1184) and
// import statements are hoisted — and the documented module's own exports are
// auto-imported. Deno's ```ts ignore fence would opt a fragment out of both gates (and
// unknown attributes like no-eval are silently IGNORED by deno, not honoured) — so the
// zero-ignore check below keeps that hatch unused: an example whose side effect must not
// run is written as a defined-but-never-invoked function instead, which both gates still
// verify in full.
// One reporting quirk: a SYNTAX error in any block aborts the whole check invocation,
// masking other files' type errors until it is fixed — the exit code still fails either
// way. (An earlier note here claimed deno's check cache could silently skip doc blocks
// after a plain check; a controlled test disproved that.)
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

// Example-presence enforcement: every exported symbol and public method in these modules
// must carry a fenced ```ts example (presence enforced here; correctness and runnability by
// `npm run typecheck` and `npm run test:doctest`). A ratchet — widen the list as other
// modules get their example backfill.
const EXAMPLE_ENFORCED = [
  'lib/result/result.ts',
  'lib/result/attempt.ts',
  'lib/result/failure.ts',
  'lib/task/task.ts',
];
// TaskClass is declared private but IS the public surface (exported as the callable `Task`
// proxy const); the doc graph cannot see through the proxy's intersection type, so its
// methods are opted in by name.
const PRIVATE_PUBLIC_CLASSES = new Set(['TaskClass']);

async function missingExamples() {
  const { code, output } = await run('deno', ['doc', '--json', ...EXAMPLE_ENFORCED]);
  if (code !== 0) return [`deno doc --json failed:\n${output}`];
  const hasFence = (jsDoc) => /```/.test(jsDoc?.doc ?? '');
  const gaps = [];
  for (const [fileUrl, entry] of Object.entries(JSON.parse(output).nodes)) {
    const file = `lib/${fileUrl.split('/lib/').pop()}`;
    for (const symbol of entry.symbols) {
      const declarations = symbol.declarations.filter(
        (d) =>
          d.declarationKind === 'export' ||
          (d.kind === 'class' && PRIVATE_PUBLIC_CLASSES.has(symbol.name)),
      );
      if (declarations.length === 0) continue;
      const classDeclaration = declarations.find((d) => d.kind === 'class');
      if (classDeclaration) {
        // Group by method name so one documented overload covers its siblings; Symbol-keyed
        // members ([Symbol.species]) and constructors (the class doc owns construction) are
        // out of scope.
        const byName = new Map();
        for (const method of classDeclaration.def.methods) {
          if (method.name.startsWith('[')) continue;
          // Static and instance methods may share a name (the data-first twins); a documented
          // instance method must not vouch for its undocumented static sibling.
          const key = `${method.isStatic ? 'static ' : ''}${method.name}`;
          const list = byName.get(key) ?? [];
          list.push(method);
          byName.set(key, list);
        }
        for (const [name, overloads] of byName) {
          if (!overloads.some((m) => hasFence(m.jsDoc))) {
            gaps.push(
              `${file}:${overloads[0].location.line} — ${symbol.name}.${name}() has no fenced example`,
            );
          }
        }
      }
      if (!declarations.some((d) => hasFence(d.jsDoc))) {
        gaps.push(
          `${file}:${declarations[0].location.line} — ${symbol.name} has no fenced example`,
        );
      }
    }
  }
  return gaps;
}

const [gateAlive, docLint, ignoreFences, exampleGaps] = await Promise.all([
  doctestGateIsAlive(),
  run('deno', ['doc', '--lint', '--quiet', 'lib/', 'cli.ts']),
  // Zero-ignore invariant: every example in the public API stays checked AND run. An
  // `ignore` fence is an example nobody verifies — convert it (stub values, or a
  // defined-but-never-invoked function) or delete it. grep exits 0 on a match.
  run('grep', ['-rnE', '```(ts|js)[^`]*\\bignore\\b', '--include=*.ts', 'lib/', 'cli.ts']),
  missingExamples(),
]);

if (exampleGaps.length > 0) {
  process.stderr.write(
    `doctest: ${exampleGaps.length} public symbol(s) without a fenced example:\n  ` +
      exampleGaps.join('\n  ') +
      '\n',
  );
  process.exitCode = 1;
}

if (ignoreFences.code === 0) {
  process.stderr.write(
    'doctest: `ignore` fence found — every example must stay checked and run:\n' +
      ignoreFences.output,
  );
  process.exitCode = 1;
}

if (!gateAlive) {
  process.stderr.write(
    'doctest canary: `deno check --doc` accepted a deliberately broken JSDoc example — ' +
      'the doctest gates (npm run typecheck / test:doctest) are no longer checking doc blocks.\n',
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
