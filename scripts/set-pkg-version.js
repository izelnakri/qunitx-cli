#!/usr/bin/env node
// Usage: node scripts/set-pkg-version.js <path/to/package.json> <version>
import { readFile, writeFile } from 'node:fs/promises';

const [pkgPath, version] = process.argv.slice(2);
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
pkg.version = version;
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
