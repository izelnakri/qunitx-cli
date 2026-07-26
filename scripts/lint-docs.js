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
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    // `output` interleaves both for human-facing reporting; JSON consumers read `stdout`
    // alone so a stray warning on stderr cannot corrupt a parse.
    proc.on('close', (code) => resolve({ code, stdout, stderr, output: stdout + stderr }));
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

// Example-presence enforcement: every public symbol and public method in lib/ must carry a
// fenced ```ts example (presence enforced here; correctness by `npm run typecheck`,
// runnability by `npm run test:doctest` — the three gates compose). "Public" is computed,
// not listed: exported symbols, plus the reachability closure of private symbols referenced
// from exported declarations (a private class behind a callable-proxy export, a private type
// alias in an exported signature — the reader meets them, so they need examples too).
// Aliases are computed, not assumed: a re-export surfaces as a declaration of kind
// 'reference' (pointing at its definition site), which is enforced where it is DEFINED — a
// barrel's re-exports inherit the definition site's doc and example (the write-once-reuse
// rule), while symbols a barrel defines itself are enforced like any other.

const hasFence = (jsDoc) => /```/.test(jsDoc?.doc ?? '');
const isExported = (symbol) => symbol.declarations.some((d) => d.declarationKind === 'export');
const gap = (file, line, what) => `${file}:${line} — ${what} has no fenced example`;

// Reachability closure: exported symbols seed the frontier; any private symbol whose quoted
// name appears in a reachable symbol's declaration defs (types, never prose) is public
// surface too — how a callable-proxy-hidden class or a private type in an exported signature
// is found without a name list. Def texts are serialised once; the worklist visits each
// symbol at most once, so this is O(symbols × frontier) with plain string scans.
function reachableNames(symbols) {
  const defTexts = new Map(
    symbols.map((s) => [s.name, JSON.stringify(s.declarations.map((d) => d.def))]),
  );
  const reached = new Set(symbols.filter(isExported).map((s) => s.name));
  for (const frontier = [...reached]; frontier.length > 0;) {
    const defText = defTexts.get(frontier.pop()) ?? '';
    for (const { name } of symbols) {
      if (!reached.has(name) && defText.includes(`"${name}"`)) {
        reached.add(name);
        frontier.push(name);
      }
    }
  }
  return reached;
}

// Method gaps, grouped by name AND staticness (a documented instance method must not vouch
// for its undocumented static twin); one documented overload covers its siblings. Symbol-keyed
// members ([Symbol.species]) and constructors (the class doc owns construction) are exempt.
const methodGaps = (file, symbolName, classDeclaration) =>
  [
    ...Map.groupBy(
      (classDeclaration.def?.methods ?? []).filter(
        (m) => !m.name.startsWith('[') && !m.name.startsWith('#') && m.accessibility !== 'private',
      ),
      (m) => `${m.isStatic ? 'static ' : ''}${m.name}`,
    ),
  ]
    .filter(([, overloads]) => !overloads.some((m) => hasFence(m.jsDoc)))
    .map(([name, [first]]) => gap(file, first.location.line, `${symbolName}.${name}()`));

// One symbol's gaps: re-export declarations (kind 'reference') are enforced at their
// definition site, so a barrel inherits the definition's doc and example (write-once-reuse)
// while symbols a barrel defines itself are enforced like any other.
const symbolGaps = (file, reachable) => (symbol) => {
  const declarations = symbol.declarations.filter((d) => d.kind !== 'reference');
  if (!reachable.has(symbol.name) || declarations.length === 0) return [];
  const classDeclaration = declarations.find((d) => d.kind === 'class');
  return [
    ...(classDeclaration ? methodGaps(file, symbol.name, classDeclaration) : []),
    ...(declarations.some((d) => hasFence(d.jsDoc))
      ? []
      : [gap(file, declarations[0].location.line, symbol.name)]),
  ];
};

async function missingExamples() {
  const files = (await readdir('lib', { recursive: true }))
    .filter((f) => f.endsWith('.ts') && !String(f).includes('..'))
    .map((f) => path.join('lib', String(f)));
  const { code, stdout, output } = await run('deno', ['doc', '--json', ...files]);
  if (code !== 0) return [`deno doc --json failed:\n${output}`];
  return Object.entries(JSON.parse(stdout).nodes).flatMap(([fileUrl, entry]) => {
    const symbols = entry.symbols ?? [];
    return symbols.flatMap(
      symbolGaps(`lib/${fileUrl.split('/lib/').pop()}`, reachableNames(symbols)),
    );
  });
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
