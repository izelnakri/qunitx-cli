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
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsr = path.join(root, 'jsr');
const STAGED = ['lib', 'templates', 'package.json'];

await Promise.all(
  STAGED.map((entry) => rm(path.join(jsr, entry), { recursive: true, force: true })),
);
await Promise.all(
  STAGED.map((entry) => cp(path.join(root, entry), path.join(jsr, entry), { recursive: true })),
);

console.log(`Staged ${STAGED.join(', ')} into jsr/`);
