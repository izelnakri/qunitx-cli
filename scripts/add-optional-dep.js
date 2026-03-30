#!/usr/bin/env node
// Usage: node scripts/add-optional-dep.js <package-name>
import { readFile, writeFile } from 'node:fs/promises';

const [pkgName] = process.argv.slice(2);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
pkg.optionalDependencies = { ...pkg.optionalDependencies, [pkgName]: '*' };
await writeFile('package.json', JSON.stringify(pkg, null, 2) + '\n');
