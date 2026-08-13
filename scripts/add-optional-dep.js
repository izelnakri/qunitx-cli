#!/usr/bin/env node
// Usage: node scripts/add-optional-dep.js <package-name>
//
// Pins the platform package to this release's exact version, not '*'. The SEA it
// carries is built from one specific commit of this package and its bin shim
// refuses a version it does not recognise, so '*' lets a consumer install a SEA
// from a different release than the CLI that dispatches to it. `make release`
// bumps package.json and publishes ./npm/<target> at the matching version before
// this runs, so the pin always resolves.
import { readFile, writeFile } from 'node:fs/promises';

const [pkgName] = process.argv.slice(2);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
pkg.optionalDependencies = { ...pkg.optionalDependencies, [pkgName]: pkg.version };
await writeFile('package.json', JSON.stringify(pkg, null, 2) + '\n');
