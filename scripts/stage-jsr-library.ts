#!/usr/bin/env node
// Stages the library into jsr/ so `deno publish` can ship it.
//
// JSR resolves every export relative to the package root — a specifier may not climb above it —
// and this package's root is jsr/, because `.` must stay the binary bootstrap that
// `deno install -Agf jsr:@izelnakri/qunitx-cli` runs. So the sources the `./api` export needs
// are copied in rather than referenced upward.
//
// Three things move, and each is load-bearing:
//   lib/        the library itself
//   templates/  read at runtime by readTemplate, whose `../../templates` candidate resolves to
//               jsr/templates from jsr/lib/utils/ — which is why the layout is mirrored exactly
//   package.json  imported by lib/commands/daemon/index.ts as '../../../package.json'
//
// Everything staged is generated, and .gitignore'd as such. Run before `deno publish`; the
// release recipe in the Makefile does exactly that.
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Target defaults to jsr/, the real staging directory. Overridable so a test can stage into a
// temp dir and assert on the result without racing a release that is staging the real one.
const jsr = path.resolve(root, process.argv[2] ?? 'jsr');
const COPIED = ['lib', 'templates'];
// Dropped from the staged package.json rather than published with it. `deno publish` resolves
// every npm dependency it can see, and v0.34.5's release died resolving `qunitx@^1.3.1` — a
// devDependency the published package never imports, whose only satisfying version was younger
// than deno's 24h minimum-dependency-age. Bumping qunitx and releasing the same day therefore
// broke the JSR publish while npm and the GitHub release had already gone out.
// `scripts` goes for the same reason it would in any published artifact: it names files that are
// not in the package, and includes a postinstall.
const UNPUBLISHED_FIELDS = ['devDependencies', 'scripts'] as const;

await Promise.all(
  [...COPIED, 'package.json'].map((entry) =>
    rm(path.join(jsr, entry), { recursive: true, force: true }),
  ),
);
await Promise.all(
  COPIED.map((entry) => cp(path.join(root, entry), path.join(jsr, entry), { recursive: true })),
);

const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
for (const field of UNPUBLISHED_FIELDS) delete manifest[field];
await writeFile(path.join(jsr, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `Staged ${COPIED.join(', ')}, package.json (without ${UNPUBLISHED_FIELDS.join(', ')}) into jsr/`,
);
